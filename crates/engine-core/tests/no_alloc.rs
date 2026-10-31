//! The audio path must not allocate. `assert_no_alloc` aborts the test binary if it does.

use assert_no_alloc::{AllocDisabler, assert_no_alloc};
use engine_core::{Command, Engine};

#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: AllocDisabler = AllocDisabler;

#[test]
fn process_does_not_allocate() {
    let (mut engine, mut ctl) = Engine::new(48_000.0);
    let mut buf = vec![0.0f32; 512 * 2];
    ctl.send(Command::Play).unwrap();
    ctl.send(Command::SetFrequency { hz: 220.0 }).unwrap();
    assert_no_alloc(|| {
        for _ in 0..1000 {
            engine.process(&mut buf, 2);
        }
    });
    while ctl.poll_event().is_some() {}
    assert!(buf.iter().any(|&s| s != 0.0));
}
