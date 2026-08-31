    fn shutdown_bridge_with_terminal_receipt(pipe_name: &str) -> Result<(), String> {
        let receipt = control(
            pipe_name,
            json!({
                "type": "bridge.shutdown",
                "requestId": format!("process-exclusion-shutdown-{}", unix_ms()),
                "sessionId": "process-exclusion-fingerprint",
                "reason": "process-exclusion-fingerprint-complete"
            }),
        )?;
        validate_shutdown_terminal_receipt(&receipt)
    }
    fn validate_shutdown_terminal_receipt(receipt: &Value) -> Result<(), String> {
        if receipt["type"] != "bridge.state.snapshot" {
            return Err(format!(
                "Bridge shutdown did not return a state snapshot terminal receipt: {receipt}"
            ));
        }
        if receipt["bridgeState"] != "stopped" || receipt["lifecycleState"] != "stopped" {
            return Err(format!(
                "Bridge shutdown receipt did not prove stopped lifecycle state: {receipt}"
            ));
        }
        let requested_generation = receipt["processLoopbackShutdownRequestedGeneration"]
            .as_u64()
            .ok_or_else(|| {
                format!("Bridge shutdown receipt omitted requested generation: {receipt}")
            })?;
        let terminal_generation = receipt["processLoopbackTerminalGeneration"]
            .as_u64()
            .ok_or_else(|| {
                format!("Bridge shutdown receipt omitted terminal generation: {receipt}")
            })?;
        if requested_generation != terminal_generation {
            return Err(format!(
                "Bridge shutdown receipt generations did not converge: requested={requested_generation} terminal={terminal_generation} receipt={receipt}"
            ));
        }
        if !matches!(
            receipt["processLoopbackTerminalStatus"].as_str(),
            Some("stopped" | "not-active")
        ) {
            return Err(format!(
                "Bridge shutdown receipt did not contain an authorized terminal status: {receipt}"
            ));
        }
        if !receipt["processLoopbackTerminalTimestampMs"].is_number() {
            return Err(format!(
                "Bridge shutdown receipt omitted terminal timestamp evidence: {receipt}"
            ));
        }
        Ok(())
    }

    fn validate_tone_receipt_identity(
        receipt: &Value,
        receipt_type: &str,
        receipt_id: &str,
        process_id: u32,
        endpoint_id: &str,
        frequency_hz: f32,
        total_frames: usize,
    ) -> Result<(), String> {
        if receipt["receiptType"].as_str() != Some(receipt_type) {
            return Err(format!(
                "tone receipt omitted trusted receiptType={receipt_type}: {receipt}"
            ));
        }
        if receipt["receiptVersion"].as_u64() != Some(1) {
            return Err(format!("tone receipt version was not 1: {receipt}"));
        }
        if receipt["receiptId"].as_str() != Some(receipt_id) {
            return Err(format!(
                "tone receiptId did not match this probe run: expected={receipt_id} receipt={receipt}"
            ));
        }
        if receipt["processId"].as_u64() != Some(process_id as u64) {
            return Err(format!(
                "tone receipt processId did not match its owned process: expected={process_id} receipt={receipt}"
            ));
        }
        if receipt["endpointId"].as_str() != Some(endpoint_id) {
            return Err(format!(
                "tone receipt endpointId did not match the measured endpoint: expected={endpoint_id} receipt={receipt}"
            ));
        }
        let actual_frequency_hz = receipt["frequencyHz"]
            .as_f64()
            .ok_or_else(|| format!("tone receipt omitted frequencyHz: {receipt}"))?
            as f32;
        if (actual_frequency_hz - frequency_hz).abs() > 0.001 {
            return Err(format!(
                "tone receipt frequencyHz did not match its fingerprint: expected={frequency_hz} actual={actual_frequency_hz} receipt={receipt}"
            ));
        }
        if receipt["totalFrames"].as_u64() != Some(total_frames as u64) {
            return Err(format!(
                "tone receipt totalFrames did not match the six-second contract: expected={total_frames} receipt={receipt}"
            ));
        }
        Ok(())
    }

    fn validate_tone_ready_receipt(
        receipt: &Value,
        receipt_id: &str,
        process_id: u32,
        endpoint_id: &str,
        frequency_hz: f32,
        total_frames: usize,
    ) -> Result<(), String> {
        validate_tone_receipt_identity(
            receipt,
            "tone-render.ready",
            receipt_id,
            process_id,
            endpoint_id,
            frequency_hz,
            total_frames,
        )?;
        if receipt["streamStarted"].as_bool() != Some(true) {
            return Err(format!(
                "tone ready receipt did not prove WASAPI stream startup: {receipt}"
            ));
        }
        Ok(())
    }

    fn validate_tone_terminal_receipt(
        receipt: &Value,
        receipt_id: &str,
        process_id: u32,
        endpoint_id: &str,
        frequency_hz: f32,
        total_frames: usize,
    ) -> Result<(), String> {
        validate_tone_receipt_identity(
            receipt,
            "tone-render.terminal",
            receipt_id,
            process_id,
            endpoint_id,
            frequency_hz,
            total_frames,
        )?;
        if receipt["passed"].as_bool() != Some(true) {
            return Err(format!("tone terminal receipt was not passed: {receipt}"));
        }
        if receipt["renderedFrames"].as_u64() != Some(total_frames as u64) {
            return Err(format!(
                "tone terminal renderedFrames did not prove a complete render: expected={total_frames} receipt={receipt}"
            ));
        }
        if receipt["playbackDrained"].as_bool() != Some(true)
            || receipt["finalPaddingFrames"].as_u64() != Some(0)
        {
            return Err(format!(
                "tone terminal receipt did not prove the WASAPI playback queue drained: {receipt}"
            ));
        }
        Ok(())
    }
