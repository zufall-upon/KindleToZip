//! OS capability boundary. Unsupported observation is never a successful empty sample.
#[cfg(windows)]
use serde_json::json;
use serde_json::Value;

pub const SUPPORTED: bool = cfg!(windows);

pub fn snapshot() -> Result<Value, &'static str> {
    #[cfg(windows)]
    { Ok(json!(crate::windows_observer::snapshot())) }
    #[cfg(not(windows))]
    { Err("observer_unsupported") }
}

pub fn window_for_process(_pid: u32) -> Result<Value, &'static str> {
    #[cfg(windows)]
    { Ok(json!(crate::windows_observer::window_for_process(_pid))) }
    #[cfg(not(windows))]
    { Err("observer_unsupported") }
}

pub fn is_above(_higher: u64, _lower: u64) -> Result<bool, &'static str> {
    #[cfg(windows)]
    { Ok(crate::windows_observer::is_above(_higher, _lower)) }
    #[cfg(not(windows))]
    { Err("observer_unsupported") }
}

pub struct Monitor {
    #[cfg(windows)]
    inner: crate::windows_observer::Monitor,
}

impl Monitor {
    pub fn start() -> Result<Self, &'static str> {
        #[cfg(windows)]
        { Ok(Self { inner: crate::windows_observer::Monitor::start() }) }
        #[cfg(not(windows))]
        { Err("observer_unsupported") }
    }

    pub fn finish(self) -> Result<Value, &'static str> {
        #[cfg(windows)]
        { self.inner.finish().map(|value| json!(value)).map_err(|_| "observer_failed") }
        #[cfg(not(windows))]
        { Err("observer_unsupported") }
    }
}
