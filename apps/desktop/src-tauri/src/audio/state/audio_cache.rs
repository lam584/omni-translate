use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

#[derive(Clone)]
pub(crate) struct CapturedSegmentAudio {
    pub cue_id: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub pcm_f32le: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct CachedTtsAudio {
    pub cache_key: String,
    pub request_id: String,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub pcm_i16: Vec<i16>,
}

struct CacheState<T> {
    entries: HashMap<String, T>,
    order: VecDeque<String>,
}

impl<T> Default for CacheState<T> {
    fn default() -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new() }
    }
}

pub(super) struct AudioCacheStore {
    segments: Mutex<CacheState<CapturedSegmentAudio>>,
    tts: Mutex<CacheState<CachedTtsAudio>>,
}

impl AudioCacheStore {
    pub(super) fn new() -> Self {
        Self { segments: Mutex::new(CacheState::default()), tts: Mutex::new(CacheState::default()) }
    }

    fn insert_bounded<T>(state: &mut CacheState<T>, key: String, value: T) {
        const MAX_ENTRIES: usize = 8;
        state.entries.insert(key.clone(), value);
        state.order.retain(|item| item != &key);
        state.order.push_front(key);
        while state.order.len() > MAX_ENTRIES {
            if let Some(expired) = state.order.pop_back() { state.entries.remove(&expired); }
        }
    }

    pub(super) fn cache_segment(&self, audio: CapturedSegmentAudio) {
        let key = audio.cue_id.clone();
        Self::insert_bounded(&mut self.segments.lock().expect("segment audio cache poisoned"), key, audio);
    }
    pub(super) fn segment(&self, cue_id: &str) -> Option<CapturedSegmentAudio> {
        self.segments.lock().expect("segment audio cache poisoned").entries.get(cue_id).cloned()
    }
    pub(super) fn cache_tts(&self, audio: CachedTtsAudio) -> usize {
        let key = audio.cache_key.clone();
        let mut state = self.tts.lock().expect("tts audio cache poisoned");
        Self::insert_bounded(&mut state, key, audio); state.entries.len()
    }
    pub(super) fn tts(&self, cache_key: &str) -> Option<CachedTtsAudio> {
        self.tts.lock().expect("tts audio cache poisoned").entries.get(cache_key).cloned()
    }
    pub(super) fn clear(&self) {
        *self.segments.lock().expect("segment audio cache poisoned") = CacheState::default();
        *self.tts.lock().expect("tts audio cache poisoned") = CacheState::default();
    }
}
