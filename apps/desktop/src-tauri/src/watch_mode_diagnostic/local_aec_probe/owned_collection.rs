//! One owned, one-shot disk collector. Live polling never joins unfinished work.
use std::thread::JoinHandle;

pub(super) struct OwnedCollection<T> {
    started: bool,
    worker: Option<JoinHandle<Result<T, String>>>,
    failure: Option<String>,
}

impl<T: Send + 'static> OwnedCollection<T> {
    pub(super) fn new() -> Self { Self { started: false, worker: None, failure: None } }

    pub(super) fn start(&mut self, collect: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<(), String> {
        if self.started { return Err("source media collection already started".into()); }
        self.started = true;
        match std::thread::Builder::new().name("aec-media-collection".into()).spawn(collect) {
            Ok(worker) => { self.worker = Some(worker); Ok(()) }
            Err(error) => { let error = error.to_string(); self.failure = Some(error.clone()); Err(error) }
        }
    }

    // A delayed collector is not media-complete. No file reads, hashes, parsing,
    // waits or unfinished join may run on the continuous renderer's pump.
    pub(super) fn poll(&mut self) -> Result<Option<T>, String> {
        if let Some(error) = &self.failure { return Err(error.clone()); }
        if self.worker.as_ref().is_some_and(|worker| worker.is_finished()) { self.resolve() }
        else { Ok(None) }
    }

    // Only cleanup AFTER render drain/abort may wait for this owned task.
    pub(super) fn finish(&mut self) -> Result<Option<T>, String> { self.resolve() }

    fn resolve(&mut self) -> Result<Option<T>, String> {
        if let Some(error) = &self.failure { return Err(error.clone()); }
        let Some(worker) = self.worker.take() else { return Ok(None); };
        match worker.join().unwrap_or_else(|_| Err("source media collection worker panicked".into())) {
            Ok(result) => Ok(Some(result)),
            Err(error) => { self.failure = Some(error.clone()); Err(error) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn blocked_collector_does_not_block_poll_or_announce_completion() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (polled_tx, polled_rx) = mpsc::channel();
        let mut task = OwnedCollection::new();
        task.start(move || { started_tx.send(()).unwrap(); release_rx.recv().unwrap(); Ok(7) }).unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let pump = std::thread::spawn(move || { let result = task.poll(); polled_tx.send(result).unwrap(); task });
        let poll = polled_rx.recv_timeout(Duration::from_secs(2));
        // Always release before asserting, so a regressed blocking join fails
        // deterministically without leaving a worker or test process stranded.
        release_tx.send(()).unwrap();
        let mut task = pump.join().unwrap();
        assert_eq!(poll.unwrap(), Ok(None));
        assert_eq!(task.resolve().unwrap(), Some(7));
        assert_eq!(task.poll().unwrap(), None);
        assert_eq!(task.finish().unwrap(), None);
    }

    #[test]
    fn completed_result_is_consumed_once_and_task_cannot_restart() {
        let mut task = OwnedCollection::new();
        assert_eq!(task.poll().unwrap(), None);
        task.start(|| Ok(9)).unwrap();
        assert_eq!(task.resolve().unwrap(), Some(9));
        assert_eq!(task.poll().unwrap(), None);
        assert!(task.start(|| Ok(10)).is_err());
        task.finish().unwrap();
    }

    #[test]
    fn collector_failure_and_panic_are_sticky_for_poll_and_cleanup() {
        for panic in [false, true] {
            let mut task: OwnedCollection<()> = OwnedCollection::new();
            task.start(move || { if panic { panic!("collector failure"); } Err("collection I/O failed".into()) }).unwrap();
            let error = task.resolve().unwrap_err();
            assert_eq!(task.poll().unwrap_err(), error);
            assert_eq!(task.finish().unwrap_err(), error);
        }
    }

    #[test]
    fn cleanup_joins_unconsumed_collection_instead_of_detaching_it() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let mut task: OwnedCollection<()> = OwnedCollection::new();
        task.start(move || { started_tx.send(()).unwrap(); release_rx.recv().unwrap(); Err("retained failure".into()) }).unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let cleanup = std::thread::spawn(move || { let result = task.finish(); finished_tx.send(result).unwrap(); task });
        assert!(finished_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        assert_eq!(finished_rx.recv_timeout(Duration::from_secs(2)).unwrap(), Err("retained failure".into()));
        let mut task = cleanup.join().unwrap();
        assert_eq!(task.poll().unwrap_err(), "retained failure");
    }
}
