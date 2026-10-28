use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Default)]
struct Point { x: i32, y: i32 }
#[repr(C)]
#[derive(Default)]
struct Rect { left: i32, top: i32, right: i32, bottom: i32 }

#[link(name = "user32")]
unsafe extern "system" {
    fn GetForegroundWindow() -> isize;
    fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn EnumWindows(callback: unsafe extern "system" fn(isize, isize) -> i32, parameter: isize) -> i32;
    fn IsWindowVisible(window: isize) -> i32;
    fn IsIconic(window: isize) -> i32;
    fn GetWindowRect(window: isize, rect: *mut Rect) -> i32;
    fn GetWindow(window: isize, relation: u32) -> isize;
}

#[derive(Clone, Copy, Serialize)]
pub struct Snapshot {
    pub foreground: u64,
    pub foreground_pid: u32,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub cursor_valid: bool,
}

pub fn snapshot() -> Snapshot {
    let mut point = Point::default();
    let mut pid = 0;
    // Read-only Win32 APIs: no focus, cursor, keyboard or mouse mutation.
    let (window, valid) = unsafe {
        let window = GetForegroundWindow();
        if window != 0 { GetWindowThreadProcessId(window, &mut pid); }
        (window, GetCursorPos(&mut point) != 0)
    };
    Snapshot { foreground: window as u64, foreground_pid: pid, cursor_x: point.x, cursor_y: point.y, cursor_valid: valid }
}

#[derive(Serialize)]
pub struct Window {
    pub handle: u64,
    pub rect: [i32; 4],
    pub minimized: bool,
}

struct Search { pid: u32, window: isize }

unsafe extern "system" fn find_window(window: isize, parameter: isize) -> i32 {
    // EnumWindows invokes this synchronously while Search remains live.
    let search = unsafe { &mut *(parameter as *mut Search) };
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(window, &mut pid); }
    if pid == search.pid && unsafe { IsWindowVisible(window) } != 0 {
        search.window = window;
        0
    } else { 1 }
}

pub fn window_for_process(pid: u32) -> Option<Window> {
    let mut search = Search { pid, window: 0 };
    unsafe { EnumWindows(find_window, &mut search as *mut Search as isize); }
    if search.window == 0 { return None; }
    let mut rect = Rect::default();
    if unsafe { GetWindowRect(search.window, &mut rect) } == 0 { return None; }
    Some(Window { handle: search.window as u64, rect: [rect.left, rect.top, rect.right, rect.bottom], minimized: unsafe { IsIconic(search.window) } != 0 })
}

pub fn is_above(higher: u64, lower: u64) -> bool {
    let mut current = lower as isize;
    for _ in 0..10_000 {
        current = unsafe { GetWindow(current, 3) }; // GW_HWNDPREV, read-only Z order.
        if current == 0 { return false; }
        if current as u64 == higher { return true; }
    }
    false
}

#[derive(Serialize)]
pub struct Observation {
    pub samples: u64,
    pub foreground_changes: u64,
    pub cursor_changes: u64,
    pub missing_foreground_samples: u64,
    pub missing_cursor_samples: u64,
    pub elapsed_ms: u64,
    pub initial: Snapshot,
    pub last: Snapshot,
}

pub struct Monitor { stop: Arc<AtomicBool>, worker: JoinHandle<Observation> }

impl Monitor {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(0);
        let worker = thread::spawn(move || {
            let started = Instant::now();
            let initial = snapshot();
            let mut result = Observation { samples: 1, foreground_changes: 0, cursor_changes: 0,
                missing_foreground_samples: u64::from(initial.foreground == 0),
                missing_cursor_samples: u64::from(!initial.cursor_valid), elapsed_ms: 0, initial, last: initial };
            let _ = sender.send(());
            // A lost parent cannot leave an unbounded observer running.
            while !signal.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(60) {
                thread::sleep(Duration::from_millis(5));
                let now = snapshot();
                result.samples += 1;
                result.foreground_changes += u64::from(now.foreground != result.last.foreground);
                result.cursor_changes += u64::from(now.cursor_valid && result.last.cursor_valid
                    && (now.cursor_x, now.cursor_y) != (result.last.cursor_x, result.last.cursor_y));
                result.missing_foreground_samples += u64::from(now.foreground == 0);
                result.missing_cursor_samples += u64::from(!now.cursor_valid);
                result.last = now;
            }
            result.elapsed_ms = started.elapsed().as_millis() as u64;
            result
        });
        let _ = receiver.recv();
        Self { stop, worker }
    }

    pub fn finish(self) -> Result<Observation, ()> {
        self.stop.store(true, Ordering::Release);
        self.worker.join().map_err(|_| ())
    }
}
