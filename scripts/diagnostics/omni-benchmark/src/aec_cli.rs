//! Zero-provider mechanical CLI for the shared strict AEC algorithm.
use std::{fs, path::{Path,PathBuf}};
use serde::Deserialize;
use omni_benchmark_core::aec::analyze_aec_closed_loop;
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Request { pre:PathBuf, post:PathBuf, source:PathBuf, physical:PathBuf, sample_rate_hz:u32 }
fn pcm(path:&Path)->Result<Vec<f32>,String> {
    let size=fs::metadata(path).map_err(|e|e.to_string())?.len();
    if size==0 || size>48_000*4*300 || size%4!=0{return Err("invalid AEC mono f32 file size".into());}
    let bytes=fs::read(path).map_err(|e|e.to_string())?;
    if bytes.len() as u64!=size{return Err("AEC file changed during read".into());}
    Ok(bytes.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect())
}
pub(super) fn try_run(arguments:&[String])->Option<Result<(),String>> {
    if arguments.first().map(String::as_str)!=Some("audio") || arguments.get(1).map(String::as_str)!=Some("aec-closed-loop") {return None;}
    Some((|| {
        if arguments.len()!=4 || arguments[2]!="--request" {return Err("audio aec-closed-loop --request <json>".into());}
        let path=Path::new(&arguments[3]);
        if fs::metadata(path).map_err(|e|e.to_string())?.len()>64*1024{return Err("AEC request exceeds bound".into());}
        let request:Request=serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        let metrics=analyze_aec_closed_loop(&pcm(&request.pre)?,&pcm(&request.post)?,&pcm(&request.source)?,&pcm(&request.physical)?,request.sample_rate_hz);
        println!("{}",serde_json::to_string(&metrics).map_err(|e|e.to_string())?);Ok(())
    })())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn only_exact_operation_is_intercepted(){assert!(try_run(&["audio".into(),"compare".into()]).is_none());assert!(try_run(&["audio".into(),"aec-closed-loop".into()]).unwrap().is_err());}
    #[test]fn request_cannot_override_thresholds(){assert!(serde_json::from_str::<Request>(r#"{"pre":"a","post":"b","source":"c","physical":"d","sampleRateHz":48000,"thresholds":{}}"#).is_err());}
}
