//! Bounded FIFO deduplication for Bridge status delivery, owned by AudioStateStore.
use std::collections::{HashSet, VecDeque};

const BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY: usize = 4_096;

#[derive(Default)]
pub(super) struct BridgeTranslationStatusReceipts {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl BridgeTranslationStatusReceipts {
    pub(super) fn insert(&mut self, status_id: &str) -> bool {
        if status_id.trim().is_empty() || self.ids.contains(status_id) {
            return false;
        }
        let status_id = status_id.to_string();
        self.ids.insert(status_id.clone());
        self.order.push_back(status_id);
        while self.order.len() > BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::AudioStateStore;

    #[test]
    fn bridge_translation_status_receipts_are_idempotent_across_route_workers() {
        let store = AudioStateStore::new();

        assert!(store.accept_bridge_translation_status_once("bridge-status-1"));
        // The receipt is retained before the source-pipe ACK is attempted. If
        // that write fails and Bridge replays after reconnect, side effects
        // remain suppressed and only the ACK is retried.
        assert!(!store.accept_bridge_translation_status_once("bridge-status-1"));
        assert!(store.accept_bridge_translation_status_once("bridge-status-2"));
        assert!(!store.accept_bridge_translation_status_once(""));
    }

    #[test]
    fn bridge_translation_status_receipts_have_a_bounded_fifo_window() {
        let store = AudioStateStore::new();
        for index in 0..=BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY {
            assert!(store.accept_bridge_translation_status_once(&format!(
                "bridge-status-{index}"
            )));
        }

        let receipts = store
            .bridge_translation_status_receipts
            .lock()
            .expect("receipt store");
        assert_eq!(receipts.ids.len(), BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY);
        assert_eq!(receipts.order.len(), BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY);
        assert!(!receipts.ids.contains("bridge-status-0"));
        assert!(receipts.ids.contains(&format!(
            "bridge-status-{}",
            BRIDGE_TRANSLATION_STATUS_RECEIPT_CAPACITY
        )));
    }
}
