use std::collections::VecDeque;

const MAX_RESPONSE_LINEAGES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ResponseLineage {
    pub(super) session_generation: u64,
    pub(super) cue_id: String,
    pub(super) source_item_id: Option<String>,
    pub(super) translation_item_id: Option<String>,
    pub(super) response_id: Option<String>,
    pub(super) completed: bool,
}

#[derive(Debug, Default, Clone)]
pub(super) struct ResponseLedger {
    session_generation: u64,
    lineages: VecDeque<ResponseLineage>,
}

impl ResponseLedger {
    pub(super) fn set_generation(&mut self, session_generation: u64) {
        if self.session_generation != session_generation {
            self.session_generation = session_generation;
            self.lineages.clear();
        }
    }

    pub(super) fn record_source(
        &mut self,
        cue_id: &str,
        source_item_id: Option<&str>,
    ) {
        let source_item_id = normalized_id(source_item_id);
        if let Some(lineage) = self.lineages.iter_mut().find(|lineage| {
            lineage.cue_id == cue_id
                || (source_item_id.is_some() && lineage.source_item_id == source_item_id)
        }) {
            lineage.cue_id = cue_id.to_string();
            if lineage.source_item_id.is_none() {
                lineage.source_item_id = source_item_id;
            }
            return;
        }
        self.lineages.push_back(ResponseLineage {
            session_generation: self.session_generation,
            cue_id: cue_id.to_string(),
            source_item_id,
            translation_item_id: None,
            response_id: None,
            completed: false,
        });
        while self.lineages.len() > MAX_RESPONSE_LINEAGES {
            self.lineages.pop_front();
        }
    }

    pub(super) fn bind_response(
        &mut self,
        response_id: Option<&str>,
        source_item_id: Option<&str>,
        translation_item_id: Option<&str>,
        fallback_cue_id: Option<&str>,
    ) -> Option<ResponseLineage> {
        let response_id = normalized_id(response_id);
        let source_item_id = normalized_id(source_item_id);
        let translation_item_id = normalized_id(translation_item_id);
        let has_item_lineage = source_item_id.is_some() || translation_item_id.is_some();
        let item_index = self
            .lineages
            .iter()
            .position(|lineage| {
                source_item_id.is_some() && lineage.source_item_id == source_item_id
            })
            .or_else(|| {
                self.lineages.iter().position(|lineage| {
                    translation_item_id.is_some()
                        && lineage.translation_item_id == translation_item_id
                })
            });
        let response_index = self
            .lineages
            .iter()
            .position(|lineage| response_id.is_some() && lineage.response_id == response_id);
        if has_item_lineage && item_index.is_none() && response_index.is_none() {
            return None;
        }
        if item_index.is_some() && response_index.is_some() && item_index != response_index {
            return None;
        }
        let exact_index = item_index.or(response_index);
        if let Some(index) = exact_index {
            let lineage = self.lineages.get(index)?;
            if source_item_id
                .as_ref()
                .is_some_and(|source| lineage.source_item_id.as_ref() != Some(source))
                || translation_item_id.as_ref().is_some_and(|translation| {
                    lineage
                        .translation_item_id
                        .as_ref()
                        .is_some_and(|bound| bound != translation)
                })
                || response_id.as_ref().is_some_and(|response| {
                    lineage
                        .response_id
                        .as_ref()
                        .is_some_and(|bound| bound != response)
                })
            {
                return None;
            }
        }
        let index = exact_index
            .or_else(|| {
                self.lineages.iter().position(|lineage| {
                    fallback_cue_id.is_some_and(|cue_id| lineage.cue_id == cue_id)
                })
            })
            .or_else(|| self.lineages.iter().position(|lineage| !lineage.completed));
        let lineage = index.and_then(|index| self.lineages.get_mut(index))?;
        if lineage.response_id.is_none() {
            lineage.response_id = response_id;
        }
        if lineage.source_item_id.is_none() {
            lineage.source_item_id = source_item_id;
        }
        if lineage.translation_item_id.is_none() {
            lineage.translation_item_id = translation_item_id;
        }
        Some(lineage.clone())
    }

    pub(super) fn complete_response(&mut self, response_id: Option<&str>) {
        let response_id = normalized_id(response_id);
        if let Some(lineage) = self
            .lineages
            .iter_mut()
            .find(|lineage| response_id.is_some() && lineage.response_id == response_id)
        {
            lineage.completed = true;
        }
    }

    pub(super) fn clear(&mut self) {
        self.lineages.clear();
    }
}

fn normalized_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "(none)")
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_source_item_binding_beats_fifo_fallback() {
        let mut ledger = ResponseLedger::default();
        ledger.set_generation(7);
        ledger.record_source("cue-one", Some("source-one"));
        ledger.record_source("cue-two", Some("source-two"));

        let lineage = ledger
            .bind_response(
                Some("response-two"),
                Some("source-two"),
                Some("translation-two"),
                None,
            )
            .expect("exact source lineage");

        assert_eq!(lineage.session_generation, 7);
        assert_eq!(lineage.cue_id, "cue-two");
        assert_eq!(lineage.translation_item_id.as_deref(), Some("translation-two"));
    }

    #[test]
    fn generation_change_rejects_prior_session_lineage() {
        let mut ledger = ResponseLedger::default();
        ledger.set_generation(1);
        ledger.record_source("old-cue", Some("old-source"));
        ledger.set_generation(2);

        assert!(ledger
            .bind_response(Some("late-response"), Some("old-source"), None, None)
            .is_none());
    }

    #[test]
    fn unknown_item_lineage_never_claims_the_fifo_cue() {
        let mut ledger = ResponseLedger::default();
        ledger.set_generation(3);
        ledger.record_source("cue-one", Some("source-one"));
        ledger.record_source("cue-two", Some("source-two"));

        assert!(ledger
            .bind_response(None, Some("unknown-source"), None, None)
            .is_none());

        let response_only = ledger
            .bind_response(Some("response-one"), None, None, None)
            .expect("a first response id binds the oldest pending owner");
        assert_eq!(response_only.cue_id, "cue-one");
        let exact = ledger
            .bind_response(Some("response-one"), None, None, None)
            .expect("subsequent response events resolve by exact response id");
        assert_eq!(exact.cue_id, "cue-one");
    }

    #[test]
    fn response_exact_match_can_bind_a_new_translation_item_once() {
        let mut ledger = ResponseLedger::default();
        ledger.set_generation(4);
        ledger.record_source("cue-one", Some("source-one"));
        ledger
            .bind_response(Some("response-one"), None, None, None)
            .expect("response.created binds the pending owner");

        let output = ledger
            .bind_response(
                Some("response-one"),
                None,
                Some("translation-one"),
                None,
            )
            .expect("the exact response may bind its first output item");
        assert_eq!(output.translation_item_id.as_deref(), Some("translation-one"));
        assert!(ledger
            .bind_response(
                Some("response-one"),
                None,
                Some("translation-other"),
                None,
            )
            .is_none());
    }
}
