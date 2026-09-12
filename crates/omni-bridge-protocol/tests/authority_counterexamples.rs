use omni_bridge_protocol::{
    accepted_audio_frame_ack, translation_header_fixture, AudioFrameAck, AudioFrameHeader,
    TranslationPlaybackStatusAck, TranslationPlaybackStatusEvent, TranslationPlaybackStatusKind,
};

fn authoritative_translation_header() -> AudioFrameHeader {
    let mut header = translation_header_fixture();
    header.session_id = "session-authority-7".to_string();
    header.bridge_instance_id = Some("bridge-instance-authority-7".to_string());
    header.source_generation = Some(41);
    header.source_generation_token = Some(
        "bridge-instance-authority-7:session-authority-7:41".to_string(),
    );
    header.playback_owner_generation = Some(73);
    header.physical_playback_device_id = Some("{physical-endpoint-7}".to_string());
    header
}

fn authoritative_translation_header_wire() -> (AudioFrameHeader, serde_json::Value) {
    let header = authoritative_translation_header();
    let header_wire = serde_json::to_value(&header).expect("translation header serializes");

    (header, header_wire)
}

fn ack_authority_tuple(wire: &serde_json::Value) -> Vec<serde_json::Value> {
    [
        "requestId",
        "frameId",
        "sessionId",
        "bridgeInstanceId",
        "sourceGeneration",
        "sourceGenerationToken",
        "playbackOwnerGeneration",
        "physicalPlaybackDeviceId",
    ]
    .into_iter()
    .map(|field| wire[field].clone())
    .collect()
}

#[test]
fn translation_frame_round_trips_the_full_authority_tuple() {
    let (_, header_wire) = authoritative_translation_header_wire();

    // Exercise the public wire decoder before constructing the ACK. Unknown
    // endpoint data being silently discarded is precisely the old-contract
    // counterexample: a consumer cannot compare data the protocol drops.
    let decoded_header: AudioFrameHeader =
        serde_json::from_value(header_wire.clone()).expect("translation header decodes");
    let decoded_header_wire =
        serde_json::to_value(&decoded_header).expect("decoded translation header serializes");
    assert_eq!(
        decoded_header_wire["physicalPlaybackDeviceId"],
        header_wire["physicalPlaybackDeviceId"],
        "physical endpoint identity must survive the production wire contract",
    );
}

#[test]
fn translation_ack_echoes_the_exact_request_frame_and_authority_tuple() {
    let (header, header_wire) = authoritative_translation_header_wire();

    let ack_wire = serde_json::to_value(accepted_audio_frame_ack(&header, 960))
        .expect("translation ACK serializes");
    for field in [
        "requestId",
        "frameId",
        "sessionId",
        "bridgeInstanceId",
        "sourceGeneration",
        "sourceGenerationToken",
        "playbackOwnerGeneration",
        "physicalPlaybackDeviceId",
    ] {
        assert_eq!(
            ack_wire[field], header_wire[field],
            "translation ACK must echo exact {field} authority",
        );
    }
}

#[test]
fn old_ack_cannot_rebind_to_same_request_and_frame_on_a_new_owner() {
    let (old_header, old_wire) = authoritative_translation_header_wire();
    let mut new_wire = old_wire.clone();
    new_wire["sessionId"] = serde_json::json!("session-authority-8");
    new_wire["bridgeInstanceId"] = serde_json::json!("bridge-instance-authority-8");
    new_wire["sourceGeneration"] = serde_json::json!(42);
    new_wire["sourceGenerationToken"] =
        serde_json::json!("bridge-instance-authority-8:session-authority-8:42");
    new_wire["playbackOwnerGeneration"] = serde_json::json!(74);
    new_wire["physicalPlaybackDeviceId"] = serde_json::json!("{physical-endpoint-8}");

    assert_eq!(old_wire["requestId"], new_wire["requestId"]);
    assert_eq!(old_wire["frameId"], new_wire["frameId"]);

    let delayed_old_ack = serde_json::to_value(accepted_audio_frame_ack(&old_header, 960))
        .expect("old owner ACK serializes");
    assert_eq!(
        ack_authority_tuple(&delayed_old_ack),
        ack_authority_tuple(&old_wire),
        "the ACK must retain the old full tuple even when request/frame IDs are reused",
    );
    assert_ne!(
        ack_authority_tuple(&delayed_old_ack),
        ack_authority_tuple(&new_wire),
        "a delayed old ACK must not validate against rebound ownership",
    );
}

#[test]
fn translation_ack_without_full_authority_is_rejected_instead_of_defaulted() {
    let legacy_ack = serde_json::json!({
        "type": "bridge.translation.ack",
        "requestId": "request-rebound",
        "frameId": "frame-rebound",
        "acceptedFrames": 480,
        "playbackFramesWritten": 480
    });

    assert!(
        serde_json::from_value::<AudioFrameAck>(legacy_ack).is_err(),
        "an ACK without session/instance/source/owner/endpoint authority must fail closed",
    );
}

#[test]
fn translation_status_and_its_receipt_require_the_same_full_authority() {
    let status = TranslationPlaybackStatusEvent {
        event_type: "bridge.translation.status".to_string(),
        status_id: "status-authority-7".to_string(),
        request_id: "status-request-authority-7".to_string(),
        session_id: "session-authority-7".to_string(),
        bridge_instance_id: "bridge-instance-authority-7".to_string(),
        source_generation: 41,
        source_generation_token:
            "bridge-instance-authority-7:session-authority-7:41".to_string(),
        playback_owner_generation: 73,
        physical_playback_device_id: "{physical-endpoint-7}".to_string(),
        cue_id: "cue-authority-7".to_string(),
        playback_status: TranslationPlaybackStatusKind::Completed,
        reason: "physical-playback-completed".to_string(),
        error_code: None,
        timestamp_ms: 7,
    };
    let ack = TranslationPlaybackStatusAck {
        event_type: "bridge.translation.status.ack".to_string(),
        status_id: status.status_id.clone(),
        session_id: status.session_id.clone(),
        bridge_instance_id: status.bridge_instance_id.clone(),
        source_generation: status.source_generation,
        source_generation_token: status.source_generation_token.clone(),
        playback_owner_generation: status.playback_owner_generation,
        physical_playback_device_id: status.physical_playback_device_id.clone(),
    };
    let status_wire = serde_json::to_value(&status).unwrap();
    let ack_wire = serde_json::to_value(&ack).unwrap();
    for field in [
        "sessionId",
        "bridgeInstanceId",
        "sourceGeneration",
        "sourceGenerationToken",
        "playbackOwnerGeneration",
        "physicalPlaybackDeviceId",
    ] {
        assert_eq!(ack_wire[field], status_wire[field]);
    }

    let legacy_ack = serde_json::json!({
        "type": "bridge.translation.status.ack",
        "statusId": status.status_id,
        "sessionId": status.session_id,
    });
    assert!(serde_json::from_value::<TranslationPlaybackStatusAck>(legacy_ack).is_err());
}
