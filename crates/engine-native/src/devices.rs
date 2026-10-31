use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

/// Every audio host (driver model) the build supports and the devices it exposes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AudioDeviceList {
    pub hosts: Vec<AudioHostInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AudioHostInfo {
    /// Driver model name, e.g. "CoreAudio", "WASAPI", "ASIO", "ALSA", "JACK".
    pub name: String,
    pub is_default: bool,
    pub devices: Vec<AudioDeviceInfo>,
    /// Set when the host is compiled in but failed to enumerate.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AudioDeviceInfo {
    /// Stable identifier, usable to reselect the device later.
    pub id: String,
    pub name: String,
    pub max_input_channels: u16,
    pub max_output_channels: u16,
    pub is_default_input: bool,
    pub is_default_output: bool,
}

/// Enumerates all available hosts and their devices. Never fails as a whole: per-host
/// failures are reported in [`AudioHostInfo::error`].
pub fn list_devices() -> AudioDeviceList {
    let default_host = cpal::default_host().id();
    let hosts = cpal::available_hosts()
        .into_iter()
        .map(|host_id| {
            let mut info = AudioHostInfo {
                name: host_id.name().to_string(),
                is_default: host_id == default_host,
                devices: Vec::new(),
                error: None,
            };
            let host = match cpal::host_from_id(host_id) {
                Ok(host) => host,
                Err(e) => {
                    info.error = Some(e.to_string());
                    return info;
                }
            };
            let id_of =
                |d: Option<cpal::Device>| d.and_then(|d| d.id().ok()).map(|id| id.to_string());
            let default_in = id_of(host.default_input_device());
            let default_out = id_of(host.default_output_device());
            match host.devices() {
                Ok(devices) => {
                    info.devices = devices
                        .filter_map(|device| {
                            let id = device.id().ok()?.to_string();
                            let name = device
                                .description()
                                .map(|d| d.name().to_string())
                                .unwrap_or_else(|_| id.clone());
                            Some(AudioDeviceInfo {
                                is_default_input: default_in.as_deref() == Some(id.as_str()),
                                is_default_output: default_out.as_deref() == Some(id.as_str()),
                                max_input_channels: max_channels(device.supported_input_configs()),
                                max_output_channels: max_channels(
                                    device.supported_output_configs(),
                                ),
                                id,
                                name,
                            })
                        })
                        .collect();
                }
                Err(e) => info.error = Some(e.to_string()),
            }
            info
        })
        .collect();
    AudioDeviceList { hosts }
}

fn max_channels<I, E>(configs: Result<I, E>) -> u16
where
    I: Iterator<Item = cpal::SupportedStreamConfigRange>,
{
    configs.map_or(0, |c| c.map(|c| c.channels()).max().unwrap_or(0))
}

impl std::fmt::Display for AudioDeviceList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for host in &self.hosts {
            writeln!(
                f,
                "{}{}",
                host.name,
                if host.is_default {
                    " (default host)"
                } else {
                    ""
                }
            )?;
            if let Some(e) = &host.error {
                writeln!(f, "  error: {e}")?;
            }
            for d in &host.devices {
                let mut tags = Vec::new();
                if d.is_default_output {
                    tags.push("default out");
                }
                if d.is_default_input {
                    tags.push("default in");
                }
                let tags = if tags.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", tags.join(", "))
                };
                writeln!(
                    f,
                    "  - {} (in {}, out {}){}",
                    d.name, d.max_input_channels, d.max_output_channels, tags
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CI runners may have no audio devices; enumeration must still succeed and serialize.
    #[test]
    fn enumerates_without_panicking() {
        let list = list_devices();
        let json = serde_json::to_value(&list).unwrap();
        assert!(json["hosts"].is_array());
        println!("{list}");
    }
}
