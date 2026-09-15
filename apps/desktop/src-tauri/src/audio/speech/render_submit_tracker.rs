#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RenderReferenceWindow {
    pub(super) start_frame: usize,
    pub(super) end_frame: usize,
    pub(super) submitted_frames: u64,
    pub(super) endpoint_padding_frames: u32,
    pub(super) played_frames: usize,
}

pub(super) struct RenderSubmitTracker {
    total_frames: usize,
    total_reference_frames: usize,
    reference_frames: usize,
    physical_prefix_frames: usize,
    reference_start_frame: usize,
    pub(super) submitted_frames: usize,
    submitted_frame_base: u64,
}

impl RenderSubmitTracker {
    #[cfg(test)]
    pub(super) fn new(total_frames: usize, reference_frames: usize) -> Self {
        Self::new_with_reference(total_frames, total_frames, reference_frames)
    }

    #[cfg(test)]
    pub(super) fn new_with_reference(
        total_frames: usize,
        total_reference_frames: usize,
        reference_frames: usize,
    ) -> Self {
        Self::new_with_reference_at(
            total_frames,
            total_reference_frames,
            reference_frames,
            0,
        )
    }

    pub(super) fn new_with_reference_at(
        total_frames: usize,
        total_reference_frames: usize,
        reference_frames: usize,
        submitted_frame_base: u64,
    ) -> Self {
        Self::new_with_reference_at_and_prefix(
            total_frames,
            total_reference_frames,
            reference_frames,
            0,
            submitted_frame_base,
        )
    }

    pub(super) fn new_with_reference_at_and_prefix(
        total_frames: usize,
        total_reference_frames: usize,
        reference_frames: usize,
        physical_prefix_frames: usize,
        submitted_frame_base: u64,
    ) -> Self {
        let physical_prefix_frames = physical_prefix_frames.min(total_frames);
        Self {
            total_frames,
            total_reference_frames: total_reference_frames
                .min(total_frames.saturating_sub(physical_prefix_frames)),
            reference_frames: reference_frames.max(1),
            physical_prefix_frames,
            reference_start_frame: 0,
            submitted_frames: 0,
            submitted_frame_base,
        }
    }

    pub(super) fn next_write_frames(&self, available_frames: usize) -> usize {
        let remaining_frames = self.total_frames.saturating_sub(self.submitted_frames);
        if self.submitted_frames < self.physical_prefix_frames {
            return available_frames
                .min(self.physical_prefix_frames - self.submitted_frames)
                .min(remaining_frames);
        }
        if self.reference_start_frame >= self.total_reference_frames {
            return available_frames.min(remaining_frames);
        }
        let next_reference_end = self
            .physical_prefix_frames
            .saturating_add(
                (self.reference_start_frame + self.reference_frames)
                    .min(self.total_reference_frames),
            )
            .min(self.total_frames);
        let pending_reference_frames = next_reference_end
            .saturating_sub(self.submitted_frames)
            .min(remaining_frames);
        (available_frames >= pending_reference_frames)
            .then_some(pending_reference_frames)
            .unwrap_or(0)
    }

    pub(super) fn record_write(
        &mut self,
        written_frames: usize,
        endpoint_padding_frames: u32,
    ) -> Result<Option<RenderReferenceWindow>, String> {
        if written_frames == 0
            || self.submitted_frames.saturating_add(written_frames) > self.total_frames
        {
            return Err("invalid WASAPI render write progress".to_string());
        }
        self.submitted_frames += written_frames;
        if endpoint_padding_frames as usize > self.submitted_frames {
            return Err(format!(
                "WASAPI render padding {} exceeds submitted position {}",
                endpoint_padding_frames, self.submitted_frames
            ));
        }
        if self.submitted_frames <= self.physical_prefix_frames {
            return Ok(None);
        }
        let reference_end_frame = self
            .submitted_frames
            .saturating_sub(self.physical_prefix_frames)
            .min(self.total_reference_frames);
        let expected_reference_end = (self.reference_start_frame + self.reference_frames)
            .min(self.total_reference_frames);
        if reference_end_frame != expected_reference_end {
            return Ok(None);
        }
        let reference_start_frame = self.reference_start_frame;
        let window = RenderReferenceWindow {
            start_frame: reference_start_frame,
            end_frame: reference_end_frame,
            submitted_frames: self
                .submitted_frame_base
                .saturating_add(self.submitted_frames as u64),
            endpoint_padding_frames,
            played_frames: self
                .submitted_frame_base
                .saturating_add(
                    self.submitted_frames
                        .saturating_sub(endpoint_padding_frames as usize) as u64,
                )
                .min(usize::MAX as u64) as usize,
        };
        self.reference_start_frame = reference_end_frame;
        Ok((reference_start_frame < reference_end_frame).then_some(window))
    }

    pub(super) fn is_complete(&self) -> bool {
        self.submitted_frames == self.total_frames
    }
}


#[cfg(test)]
mod tests {
    use super::RenderSubmitTracker;

    #[test]
    fn physical_prefix_is_submitted_before_the_first_reference_window() {
        let mut tracker =
            RenderSubmitTracker::new_with_reference_at_and_prefix(1_920, 960, 480, 960, 0);
        for expected_submitted in [480, 960] {
            let written = tracker.next_write_frames(480);
            assert_eq!(written, 480);
            assert!(tracker
                .record_write(written, expected_submitted)
                .expect("prefix write")
                .is_none());
        }
        let written = tracker.next_write_frames(480);
        let first = tracker
            .record_write(written, 1_440)
            .expect("first reference write")
            .expect("first reference must start after the physical prefix");
        assert_eq!((first.start_frame, first.end_frame), (0, 480));
        assert_eq!(first.submitted_frames, 1_440);
    }

    #[test]
    fn prefix_boundary_is_not_crossed_by_a_partial_reference_write() {
        let mut tracker =
            RenderSubmitTracker::new_with_reference_at_and_prefix(1_560, 960, 480, 600, 0);
        let first = tracker.next_write_frames(480);
        assert_eq!(first, 480);
        assert!(tracker
            .record_write(first, 480)
            .expect("prefix write")
            .is_none());
        let prefix_tail = tracker.next_write_frames(480);
        assert_eq!(prefix_tail, 120);
        assert!(tracker
            .record_write(prefix_tail, 600)
            .expect("prefix tail")
            .is_none());
        assert_eq!(tracker.next_write_frames(479), 0);
        let reference = tracker.next_write_frames(480);
        let window = tracker
            .record_write(reference, 1_080)
            .expect("reference write")
            .expect("complete reference window");
        assert_eq!((window.start_frame, window.end_frame), (0, 480));
    }

    #[test]
    fn prefixed_reference_windows_advance_monotonically_across_multiple_writes() {
        let mut tracker =
            RenderSubmitTracker::new_with_reference_at_and_prefix(2_160, 1_440, 480, 720, 0);
        let mut windows = Vec::new();
        while !tracker.is_complete() {
            let written = tracker.next_write_frames(480);
            assert!(written > 0);
            let padding = (tracker.submitted_frames + written) as u32;
            if let Some(window) = tracker.record_write(written, padding).expect("paced write") {
                windows.push((
                    window.start_frame,
                    window.end_frame,
                    window.submitted_frames,
                ));
            }
        }
        assert_eq!(
            windows,
            vec![(0, 480, 1_200), (480, 960, 1_680), (960, 1_440, 2_160)]
        );
    }

    #[test]
    fn physical_tail_after_the_reference_is_submitted_without_a_future_window() {
        let mut tracker =
            RenderSubmitTracker::new_with_reference_at_and_prefix(1_680, 960, 480, 480, 0);
        for expected_submitted in [480, 960, 1_440] {
            let written = tracker.next_write_frames(480);
            assert_eq!(written, 480);
            let _ = tracker
                .record_write(written, expected_submitted)
                .expect("paced write");
        }
        assert_eq!(tracker.next_write_frames(480), 240);
        assert!(tracker
            .record_write(240, 1_680)
            .expect("physical tail")
            .is_none());
        assert!(tracker.is_complete());
    }
}
