use super::*;
#[path = "../samples.rs"]
mod production_samples;
fn pcm(frames:usize,value:f32)->Vec<u8>{(0..frames*2).flat_map(|_|value.to_le_bytes()).collect()}
fn p(frame:u64,frames:usize,disc:bool)->PacketTime{PacketTime{frame,qpc:10_000_000+frame*10_000_000/48_000,frames,discontinuity:disc,timestamp_error:false}}
fn drain(s:&mut CapturePacketSegments,q:&mut VecDeque<u8>)->Vec<Vec<u8>>{
 let before=q.len();let chunks=production_samples::drain_sample_chunks(q,960*8);
 s.dequeued(1,before,q.len(),chunks.iter().map(Vec::len).sum()).unwrap();chunks
}
#[test]
fn actual_96_frame_old_segment_finishes_before_480_frame_new_segment(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(96,0.125));
 s.append(1,0,&q,p(2400,96,true)).unwrap();assert!(drain(&mut s,&mut q).is_empty());
 let old=q.len();q.extend(pcm(480,0.25));let a=s.append(1,old,&q,p(3360,480,true)).unwrap();
 let permit=a.prefix.unwrap();let proof=permit.proof();assert_eq!((proof.frames,proof.old_head_frame,proof.old_end_frame),(96,2400,2496));
 let before=q.len();let prefix=s.take_prefix(&mut q,permit).unwrap();s.dequeued(1,before,q.len(),prefix.len()).unwrap();
 assert_eq!(prefix,pcm(96,0.125));assert_eq!(q.iter().copied().collect::<Vec<_>>(),pcm(480,0.25));
 assert!(s.reset_required());complete(&mut s,proof);s.acknowledge_reset().unwrap();let before=q.len();q.extend(pcm(480,0.5));
 let a=s.append(1,before,&q,p(3840,480,false)).unwrap();assert!(a.prefix.is_none());
 let new=drain(&mut s,&mut q);assert_eq!(new.len(),1);assert_eq!(new[0][..480*8],pcm(480,0.25));assert_eq!(new[0][480*8..],pcm(480,0.5));assert!(q.is_empty());
 assert_eq!(prefix.len()+new[0].len(),1056*8);
}
#[test]
fn all_1_to_959_old_prefixes_are_exact_and_never_join_the_new_native_block(){
 for n in 1..960 {let mut s=CapturePacketSegments::new(1).unwrap();let old=pcm(n,0.125);let mut q=VecDeque::from(old.clone());
  s.append(1,0,&q,p(480,n,false)).unwrap();let before=q.len();q.extend(pcm(960,0.25));
  let a=s.append(1,before,&q,p(480+n as u64+864,960,false)).unwrap();assert_eq!(a.reason,Some("device-frame-gap"));
  let permit=a.prefix.unwrap();let proof=permit.proof();let before=q.len();let prefix=s.take_prefix(&mut q,permit).unwrap();s.dequeued(1,before,q.len(),prefix.len()).unwrap();
  assert_eq!(prefix,old);complete(&mut s,proof);s.acknowledge_reset().unwrap();let out=drain(&mut s,&mut q);assert_eq!(out,vec![pcm(960,0.25)]);assert!(q.is_empty());
 }
}
#[test]
fn boundary_survives_until_successful_reset_even_with_no_old_prefix(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(960,0.1));
 s.append(1,0,&q,p(480,960,false)).unwrap();drain(&mut s,&mut q);
 q.extend(pcm(480,0.2));let a=s.append(1,0,&q,p(2000,480,false)).unwrap();assert!(a.prefix.is_none());assert!(s.reset_required());
 let before=q.len();q.extend(pcm(480,0.3));assert!(s.append(1,before,&q,p(2480,480,false)).is_err());
 // Failed append is state-preserving. Only reset acknowledgment permits retry.
 s.acknowledge_reset().unwrap();s.append(1,before,&q,p(2480,480,false)).unwrap();
}
#[test]
fn empty_packet_does_not_clear_identity_or_boundary(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(96,0.1));s.append(1,0,&q,p(480,96,false)).unwrap();
 let b=q.len();q.extend(pcm(480,0.2));s.append(1,b,&q,p(1440,480,true)).unwrap();let gen=s.generation;
 assert!(s.append(1,q.len(),&q,p(0,0,false)).is_err());assert!(s.reset_required());assert_eq!(s.generation,gen);
}
#[test]
fn exact_bytes_owner_generation_and_queue_size_are_checked_before_dequeue(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(96,0.1));s.append(1,0,&q,p(480,96,false)).unwrap();
 let b=q.len();q.extend(pcm(480,0.2));let a=s.append(1,b,&q,p(1440,480,true)).unwrap();let permit=a.prefix.unwrap();
 q[0]^=1;let copy=q.clone();assert!(s.take_prefix(&mut q,permit).is_err());assert_eq!(q,copy);
 assert!(s.dequeued(2,q.len(),q.len()-8,8).is_err());assert!(s.dequeued(1,q.len(),q.len()-8,7).is_err());
}
#[test]
fn timestamp_errors_and_untrusted_predecessors_are_separate_boundaries(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(960,0.1));s.append(1,0,&q,p(480,960,false)).unwrap();drain(&mut s,&mut q);
 let mut bad=p(1440,960,false);bad.timestamp_error=true;q.extend(pcm(960,0.2));let a=s.append(1,0,&q,bad).unwrap();assert_eq!(a.reason,Some("timestamp-error"));s.acknowledge_reset().unwrap();drain(&mut s,&mut q);
 q.extend(pcm(960,0.3));let a=s.append(1,0,&q,p(2400,960,false)).unwrap();assert_eq!(a.reason,Some("untrusted-predecessor"));
}
#[test]
fn append_errors_never_commit_owner_or_generation_or_segment_changes(){
 let mut s=CapturePacketSegments::new(1).unwrap();let q=VecDeque::from(pcm(480,0.1));assert!(s.append(2,0,&q,p(480,480,false)).is_err());assert_eq!(s.generation,0);
 let mut bad=PacketTime { frame:u64::MAX, qpc:10_000_000, frames:480, discontinuity:false, timestamp_error:false };bad.timestamp_error=false;assert!(s.append(1,0,&q,bad).is_err());assert_eq!(s.generation,0);
 s.generation=u64::MAX;assert!(s.append(1,0,&q,p(480,480,false)).is_err());assert_eq!(s.segment,1);
}
#[test]
fn normal_contiguous_audio_keeps_existing_eager_batch_order_and_content(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(3000,0.25));s.append(1,0,&q,p(480,3000,false)).unwrap();
 let chunks=drain(&mut s,&mut q);assert_eq!(chunks.len(),3);assert!(chunks.iter().all(|c|*c==pcm(960,0.25)));assert_eq!(q.len(),120*8);
 let b=q.len();q.extend(pcm(480,0.5));let a=s.append(1,b,&q,p(3480,480,false)).unwrap();assert!(a.prefix.is_none());assert_eq!(a.segment,1);
}
#[test]
fn successive_boundaries_preserve_every_real_frame_exactly_once(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::new();let mut frame=480;let mut emitted=Vec::new();let mut expected: Vec<u8> = Vec::new();
 for i in 1..101 {let n=i%479+1;let bytes=pcm(n,i as f32/128.0);expected.extend_from_slice(&bytes);let before=q.len();q.extend(bytes);
  let a=s.append(1,before,&q,p(frame,n,i>1)).unwrap();if let Some(permit)=a.prefix {let proof=permit.proof();let before=q.len();let bytes=s.take_prefix(&mut q,permit).unwrap();s.dequeued(1,before,q.len(),bytes.len()).unwrap();complete(&mut s,proof);emitted.extend(bytes);}
  if s.reset_required(){s.acknowledge_reset().unwrap();}frame+=n as u64+864;
 }
 emitted.extend(q);assert_eq!(emitted,expected);
}
#[test]
fn early_reset_or_normal_dequeue_cannot_skip_a_retained_boundary_prefix(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(96,0.1));
 s.append(1,0,&q,p(480,96,false)).unwrap();let before=q.len();q.extend(pcm(960,0.2));
 let a=s.append(1,before,&q,p(1440,960,true)).unwrap();let unchanged=q.clone();
 assert!(s.acknowledge_reset().is_err());assert!(s.normal_dequeue_ready().is_err());assert_eq!(q,unchanged);
 let permit=a.prefix.unwrap();let proof=permit.proof();let before=q.len();let old=s.take_prefix(&mut q,permit).unwrap();
 assert!(s.acknowledge_reset().is_err());s.dequeued(1,before,q.len(),old.len()).unwrap();
 assert!(s.normal_dequeue_ready().is_err());assert!(s.acknowledge_reset().is_err());complete(&mut s,proof);s.acknowledge_reset().unwrap();s.normal_dequeue_ready().unwrap();
 let new=drain(&mut s,&mut q);assert_eq!(new,vec![pcm(960,0.2)]);
}

#[test]
fn prefix_dequeue_is_not_aec_and_dispatch_completion_and_cannot_reset() {
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(96,0.1));
 s.append(1,0,&q,p(480,96,false)).unwrap();let before=q.len();q.extend(pcm(480,0.2));
 let a=s.append(1,before,&q,p(1440,480,true)).unwrap();let permit=a.prefix.unwrap();
 let before=q.len();let old=s.take_prefix(&mut q,permit).unwrap();
 s.dequeued(1,before,q.len(),old.len()).unwrap();
 assert!(s.boundary_reset_ready().is_err(), "dequeue alone must not authorize an engine reset before AEC/dispatch");
 assert!(s.acknowledge_reset().is_err());
}
// Unit-level successful processing receipt; the worker supplies it only after
// real synchronous AEC and dispatch. These fixtures do not claim physical output.
fn complete(s:&mut CapturePacketSegments,proof:BoundaryProof){
 s.complete_prefix_processing(proof.owner,proof.generation,proof.id,proof.frames).unwrap();
}
#[test]
fn completion_is_one_use_and_binds_exact_owner_generation_boundary_and_frames(){
 let mut s=CapturePacketSegments::new(1).unwrap();let mut q=VecDeque::from(pcm(96,0.1));
 s.append(1,0,&q,p(480,96,false)).unwrap();let before=q.len();q.extend(pcm(480,0.2));
 let permit=s.append(1,before,&q,p(1440,480,true)).unwrap().prefix.unwrap();let proof=permit.proof();
 assert!(s.complete_prefix_processing(proof.owner,proof.generation,proof.id,proof.frames).is_err());
 let before=q.len();let old=s.take_prefix(&mut q,permit).unwrap();
 assert!(s.complete_prefix_processing(proof.owner,proof.generation,proof.id,proof.frames).is_err());
 s.dequeued(1,before,q.len(),old.len()).unwrap();
 for (owner,generation,id,frames) in [(2,proof.generation,proof.id,96),(1,proof.generation+1,proof.id,96),
  (1,proof.generation,proof.id+1,96),(1,proof.generation,proof.id,95)]{
  assert!(s.complete_prefix_processing(owner,generation,id,frames).is_err());
  assert!(s.boundary_reset_ready().is_err());
 }
 complete(&mut s,proof);
 assert!(s.complete_prefix_processing(proof.owner,proof.generation,proof.id,proof.frames).is_err());
 s.boundary_reset_ready().unwrap();s.acknowledge_reset().unwrap();s.normal_dequeue_ready().unwrap();
}