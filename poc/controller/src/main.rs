mod windows_observer;

use ktz_g02_controller::store::{create_private_session_directory, lock_data_directory, ArchiveFormat, BookIdentity, CaptureSettings, PageOutputMode, PageSide, Store};
use ktz_g02_controller::{transition, Event, State};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use windows_observer::{is_above, snapshot, window_for_process, Monitor};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { version: u8, id: u64, command: Command }

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Transition { event: Event }, State {}, Snapshot {},
    WindowForProcess { pid: u32 }, WindowAbove { higher: u64, lower: u64 },
    ObserveStart {}, ObserveStop {}, Close {},
    CreateJob { base_dir: String }, OpenJob { path: String }, JobInfo {}, JobProgress {}, CloseJob {},
    CaptureStart {}, CapturePause {}, CaptureStop {},
    ResetImages {},
    SetCaptureSettings { capture_settings: CaptureSettings },
    ResumeConfirm { last_capture_id: Option<u64>, target_confirmed: bool },
    CaptureBegin {}, CaptureChunk { capture_id: u64, data_base64: String }, CaptureCommit { book: Option<BookIdentity>, position: Option<String> }, CaptureAbort {},
    RecordAdvance { capture_id: u64, dispatch: String },
    LayoutBegin {}, LayoutChunk { data_base64: String }, LayoutResult {},
    SetReviewOrder { capture_ids: Vec<u64> }, ConfirmRange { confirmed: bool },
    CropImage { capture_id: u64, x: u32, y: u32, width: u32, height: u32 },
    ResetCrop { capture_id: u64 },
    SetPageLayout { capture_id: u64, mode: PageOutputMode, first_page: PageSide },
    Export { destination: String, format: String, #[serde(default)] progress: bool }, CreateSessionDirectory { path: String }, LockDataDirectory { path: String },
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut state = State::Preview;
    let mut monitor: Option<Monitor> = None;
    let mut store: Option<Store> = None;
    let mut data_lock = None;
    let mut last_id = 0;
    let mut layout_bytes: Option<Vec<u8>> = None;
    loop {
        let mut bytes = Vec::new();
        // Read bounded framing before JSON parsing. EOF also closes the observer.
        let count = input.by_ref().take(65_537).read_until(b'\n', &mut bytes)?;
        if count == 0 { break; }
        if count > 65_536 || bytes.last() != Some(&b'\n') {
            writeln!(output, "{{\"version\":1,\"id\":0,\"ok\":false,\"code\":\"invalid_frame\"}}")?;
            output.flush()?;
            break;
        }
        let request: Request = match serde_json::from_slice(&bytes) {
            Ok(request) => request,
            Err(_) => {
                writeln!(output, "{{\"version\":1,\"id\":0,\"ok\":false,\"code\":\"invalid_request\"}}")?;
                output.flush()?;
                break;
            }
        };
        if request.version != 1 || request.id <= last_id {
            writeln!(output, "{}", json!({"version":1,"id":request.id,"ok":false,"code":"protocol_mismatch"}))?;
            output.flush()?;
            break;
        }
        last_id = request.id;
        let closing = matches!(&request.command, Command::Close {});
        let result: Result<Value, &'static str> = match request.command {
            Command::Transition { event } => match transition(state, event) {
                Ok(next) => { state = next; Ok(json!({"state":state})) },
                Err(_) => Err("invalid_transition"),
            },
            Command::State {} => Ok(json!({"state":state})),
            Command::LayoutBegin {} => { layout_bytes = Some(Vec::new()); Ok(json!({})) },
            Command::LayoutChunk { data_base64 } => match (layout_bytes.as_mut(), decode_base64(&data_base64)) {
                (Some(buffer), Ok(bytes)) if buffer.len() + bytes.len() <= ktz_g02_controller::png_image::MAX_PNG_BYTES => { buffer.extend(bytes); Ok(json!({})) },
                _ => { layout_bytes = None; Err("invalid_chunk") },
            },
            Command::LayoutResult {} => match layout_bytes.take() {
                Some(bytes) => ktz_g02_controller::png_image::decode(&bytes).map(|image| json!({"layout": if image.single_page() { "single_page" } else { "spread" }})),
                None => Err("invalid_chunk"),
            },
            Command::Snapshot {} => Ok(json!({"snapshot":snapshot()})),
            Command::WindowForProcess { pid } => Ok(json!({"window":window_for_process(pid)})),
            Command::WindowAbove { higher, lower } => Ok(json!({"above":is_above(higher, lower)})),
            Command::ObserveStart {} if monitor.is_none() => { monitor = Some(Monitor::start()); Ok(json!({})) },
            Command::ObserveStart {} => Err("observer_busy"),
            Command::ObserveStop {} => match monitor.take() {
                Some(active) => active.finish().map(|result| json!({"observation":result})).map_err(|_| "observer_failed"),
                None => Err("observer_not_started"),
            },
            Command::CreateJob { base_dir } => {
                if store.is_some() { Err("job_already_open") }
                else {
                    match Store::create(Path::new(&base_dir)) {
                        Ok(active) => match active.snapshot() {
                            Ok(snapshot) => { store = Some(active); Ok(json!({"snapshot":snapshot})) },
                            Err(error) => Err(error.code()),
                        },
                        Err(error) => Err(error.code()),
                    }
                }
            }
            Command::OpenJob { path } => {
                if store.is_some() { Err("job_already_open") }
                else {
                    match Store::open(Path::new(&path)) {
                        Ok(active) => match active.snapshot() {
                            Ok(snapshot) => { store = Some(active); Ok(json!({"snapshot":snapshot})) },
                            Err(error) => Err(error.code()),
                        },
                        Err(error) => Err(error.code()),
                    }
                }
            }
            Command::JobInfo {} => match store.as_ref() {
                Some(active) => active.snapshot().map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::JobProgress {} => match store.as_ref() {
                Some(active) => Ok(json!({"manifest":active.manifest()})),
                None => Err("job_not_open"),
            },
            Command::CloseJob {} => match store.take() {
                Some(active) => active.close().map(|_| json!({})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CaptureStart {} => match store.as_mut() {
                Some(active) => active.start_capture().map(|state| json!({"state":state})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::ResetImages {} => match store.as_mut() {
                Some(active) => active.reset_images().map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CapturePause {} => match store.as_mut() {
                Some(active) => active.pause_capture().map(|state| json!({"state":state})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CaptureStop {} => match store.as_mut() {
                Some(active) => active.stop_capture().map(|state| json!({"state":state})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::SetCaptureSettings { capture_settings } => match store.as_mut() {
                Some(active) => active.set_capture_settings(capture_settings).map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::ResumeConfirm { last_capture_id, target_confirmed } => match store.as_mut() {
                Some(active) => active.confirm_resume(last_capture_id, target_confirmed).map(|state| json!({"state":state})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CaptureBegin {} => match store.as_mut() {
                Some(active) => active.begin_capture().map(|capture_id| json!({"capture_id":capture_id})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CaptureChunk { capture_id, data_base64 } => match (store.as_mut(), decode_base64(&data_base64)) {
                (Some(active), Ok(bytes)) => active.write_capture_chunk(capture_id, &bytes).map(|bytes| json!({"bytes":bytes})).map_err(|error| error.code()),
                (Some(_), Err(code)) => Err(code),
                (None, _) => Err("job_not_open"),
            },
            Command::RecordAdvance { capture_id, dispatch } => match store.as_mut() {
                Some(active) => active.record_advance(capture_id, dispatch).map(|_| json!({})).map_err(|error| error.code()),
                None => Err("job_required"),
            },
            Command::CaptureCommit { book, position } => match store.as_mut() {
                Some(active) => active.commit_capture_at(book, position).map(|capture| json!({"capture":capture})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CaptureAbort {} => match store.as_mut() {
                Some(active) => active.abort_capture().map(|_| json!({})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::SetReviewOrder { capture_ids } => match store.as_mut() {
                Some(active) => active.set_review_order(capture_ids).map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::ConfirmRange { confirmed } => match store.as_mut() {
                Some(active) => active.confirm_range(confirmed).map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::CropImage { capture_id, x, y, width, height } => match store.as_mut() {
                Some(active) => active.crop_image(capture_id, x, y, width, height)
                    .map(|result| json!({"crop":result.crop,"cleanup_warning":result.cleanup_warning}))
                    .map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::SetPageLayout { capture_id, mode, first_page } => match store.as_mut() {
                Some(active) => active.set_page_layout(capture_id, mode, first_page).map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::ResetCrop { capture_id } => match store.as_mut() {
                Some(active) => active.reset_crop(capture_id).map(|snapshot| json!({"snapshot":snapshot})).map_err(|error| error.code()),
                None => Err("job_not_open"),
            },
            Command::Export { destination, format, progress } => match (store.as_mut(), ArchiveFormat::parse(&format)) {
                (Some(active), Ok(format)) => active.export_progress(Path::new(&destination), format, &mut |done, total, stage| {
                    if !progress { return; }
                    let _ = writeln!(output, "{}", json!({"version":1,"id":request.id,"ok":true,"progress":{"done":done,"total":total,"stage":stage}}));
                    let _ = output.flush();
                }).map(|export| json!({"export":export})).map_err(|error| error.code()),
                (Some(_), Err(error)) => Err(error.code()),
                (None, _) => Err("job_not_open"),
            },
            Command::CreateSessionDirectory { path } => create_private_session_directory(Path::new(&path)).map(|path| json!({"path":path})).map_err(|error| error.code()),
            Command::LockDataDirectory { path } => {
                if data_lock.is_some() { Err("data_directory_already_locked") }
                else { match lock_data_directory(Path::new(&path)) {
                    Ok(lock) => { data_lock = Some(lock); Ok(json!({})) },
                    Err(error) => Err(error.code()),
                } }
            },
            Command::Close {} => {
                if let Some(active) = store.take() { active.close().map(|_| json!({})).map_err(|error| error.code()) }
                else { Ok(json!({})) }
            },
        };
        let response = match result {
            Ok(payload) => json!({"version":1,"id":request.id,"ok":true,"payload":payload}),
            Err(code) => json!({"version":1,"id":request.id,"ok":false,"code":code}),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
        if closing { break; }
    }
    if let Some(active) = monitor { let _ = active.finish(); }
    Ok(())
}

fn decode_base64(text: &str) -> Result<Vec<u8>, &'static str> {
    if text.is_empty() || text.len() > 46_000 || text.len() % 4 != 0 {
        return Err("invalid_chunk");
    }
    let mut output = Vec::with_capacity(text.len() / 4 * 3);
    let bytes = text.as_bytes();
    for (block_index, block) in bytes.chunks_exact(4).enumerate() {
        let last = block_index + 1 == bytes.len() / 4;
        let a = base64_value(block[0]).ok_or("invalid_chunk")?;
        let b = base64_value(block[1]).ok_or("invalid_chunk")?;
        let c = if block[2] == b'=' { 0 } else { base64_value(block[2]).ok_or("invalid_chunk")? };
        let d = if block[3] == b'=' { 0 } else { base64_value(block[3]).ok_or("invalid_chunk")? };
        if (block[2] == b'=' && (block[3] != b'=' || !last)) || (block[3] == b'=' && !last) {
            return Err("invalid_chunk");
        }
        if (block[2] == b'=' && b & 0x0f != 0) || (block[3] == b'=' && block[2] != b'=' && c & 0x03 != 0) {
            return Err("invalid_chunk");
        }
        output.push((a << 2) | (b >> 4));
        if block[2] != b'=' { output.push((b << 4) | (c >> 2)); }
        if block[3] != b'=' { output.push((c << 6) | d); }
    }
    if output.is_empty() { return Err("invalid_chunk"); }
    Ok(output)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}
