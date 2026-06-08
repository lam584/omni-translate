use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::common::MapErrToString;

use super::schema::DEFAULT_CONFIG_JSON;

pub(super) fn default_config_value() -> Result<Value, String> {
    serde_json::from_str(DEFAULT_CONFIG_JSON).map_err_str()
}

pub(super) fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err_str()?;
    }

    let content = serde_json::to_string_pretty(value).map_err_str()?;
    fs::write(path, content).map_err_str()
}

pub(super) fn merge_objects(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                merge_objects(
                    target_map.entry(key.clone()).or_insert(Value::Null),
                    patch_value,
                );
            }
        }
        (target_value, patch_value) => {
            *target_value = patch_value.clone();
        }
    }
}

pub(super) fn enforce_current_driver_contract(config: &mut Value, defaults: &Value) {
    for key in [
        "protocolVersion",
        "expectedDriverVersion",
        "expectedBridgeVersion",
    ] {
        let Some(default_value) = defaults.pointer(&format!("/driver/{key}")).cloned() else {
            continue;
        };
        if let Some(driver) = config.get_mut("driver").and_then(Value::as_object_mut) {
            driver.insert(key.to_string(), default_value);
        }
    }
}

pub(super) fn string_at(root: &Value, pointer: &str) -> Option<String> {
    root.pointer(pointer)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(super) fn bool_at(root: &Value, pointer: &str) -> Option<bool> {
    root.pointer(pointer).and_then(Value::as_bool)
}

pub(super) fn i64_at(root: &Value, pointer: &str) -> Option<i64> {
    root.pointer(pointer).and_then(Value::as_i64)
}

pub(super) fn f64_at(root: &Value, pointer: &str) -> Option<f64> {
    root.pointer(pointer).and_then(Value::as_f64)
}

pub(super) fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}
