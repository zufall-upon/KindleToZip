//! Rust state guard and offline local-storage core for the Windows MVP.
//! Local persistence does not depend on account or entitlement state.

mod archive;
pub mod png_image;
pub mod store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum State {
    Preview,
    Ready,
    Capturing,
    Paused,
    ResumeCheck,
    NeedsAttention,
    Review,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum Event {
    ApprovePreview,
    ExplicitStart,
    Pause,
    RequestResume,
    ConfirmTargetAndPosition,
    TargetChanged,
    AuthRequired,
    CaptureFailed,
    AdvanceUncertain,
    EndCandidate,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTransition;

pub fn transition(state: State, event: Event) -> Result<State, InvalidTransition> {
    use Event::*;
    match (state, event) {
        (_, Stop) => Ok(State::Review),
        (_, TargetChanged | AuthRequired | CaptureFailed | AdvanceUncertain | EndCandidate) => {
            Ok(State::NeedsAttention)
        }
        (State::Preview, ApprovePreview) => Ok(State::Ready),
        (State::Ready, ExplicitStart) => Ok(State::Capturing),
        (State::Capturing, Pause) => Ok(State::Paused),
        (State::Paused | State::NeedsAttention, RequestResume) => Ok(State::ResumeCheck),
        (State::ResumeCheck, ConfirmTargetAndPosition) => Ok(State::Ready),
        _ => Err(InvalidTransition),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_and_resume_both_require_an_explicit_start() {
        assert_eq!(transition(State::Preview, Event::ExplicitStart), Err(InvalidTransition));
        assert_eq!(transition(State::Preview, Event::ApprovePreview), Ok(State::Ready));
        assert_eq!(transition(State::Ready, Event::ExplicitStart), Ok(State::Capturing));
        assert_eq!(transition(State::Capturing, Event::Pause), Ok(State::Paused));
        assert_eq!(transition(State::Paused, Event::ExplicitStart), Err(InvalidTransition));
        assert_eq!(transition(State::Paused, Event::RequestResume), Ok(State::ResumeCheck));
        assert_eq!(transition(State::ResumeCheck, Event::ConfirmTargetAndPosition), Ok(State::Ready));
    }

    #[test]
    fn unknown_end_and_errors_are_never_success() {
        for event in [Event::TargetChanged, Event::AuthRequired, Event::CaptureFailed,
            Event::AdvanceUncertain, Event::EndCandidate] {
            assert_eq!(transition(State::Capturing, event), Ok(State::NeedsAttention));
        }
        assert_eq!(transition(State::Capturing, Event::Stop), Ok(State::Review));
    }
}
