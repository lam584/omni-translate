//! Cohesive provider protocol building blocks used by `ProviderGateway`.
//!
//! Keep provider-specific transport code out of the gateway facade.  The
//! facade owns the application-facing API while these modules own protocol
//! details and are independently testable.

pub(crate) mod auth;
pub(crate) mod dashscope;
pub(crate) mod models;
pub(crate) mod openai;
pub(crate) mod probe;
pub(crate) mod realtime_audio;
pub(crate) mod routing;
pub(crate) mod shared;
pub(crate) mod time;
pub(crate) mod transport;
