use std::io;

#[derive(Debug)]
pub(crate) enum MutationError {
    NotApplied(io::Error),
    AppliedDurabilityUnknown(io::Error),
}
pub(crate) type MutationResult<T> = Result<T, MutationError>;
impl From<io::Error> for MutationError {
    fn from(error: io::Error) -> Self { Self::NotApplied(error) }
}
impl MutationError {
    pub(crate) fn kind(&self) -> io::ErrorKind {
        match self { Self::NotApplied(e) | Self::AppliedDurabilityUnknown(e) => e.kind() }
    }
    pub(crate) fn applied(&self) -> bool { matches!(self, Self::AppliedDurabilityUnknown(_)) }
}
impl std::fmt::Display for MutationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotApplied(error) => write!(f, "not applied: {error}"),
            Self::AppliedDurabilityUnknown(error) => write!(f, "applied; durability unknown: {error}"),
        }
    }
}
