//! Prints every audio host and device: `cargo run -p engine-native --example devices`.

fn main() {
    print!("{}", engine_native::list_devices());
}
