//! Sony VID/PID table and per-model transport quirks.
//! Reference: docs/ds4-hid-notes.md

pub const SONY_VID: u16 = 0x054C;

pub const DS4_V1_PID: u16 = 0x05C4;
pub const DS4_V2_PID: u16 = 0x09CC;
pub const DS4_PS3_PID: u16 = 0x0BA0;
pub const DUALSENSE_PID: u16 = 0x0CE6;
pub const DUALSENSE_EDGE_PID: u16 = 0x0DF2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Model {
    Ds4,
    DualSense,
    DualSenseEdge,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Transport {
    Usb,
    Bluetooth,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Quirks {
    pub no_output_data: bool,
    pub no_battery_reading: bool,
    pub only_usb_output_report: bool,
}

impl Model {
    pub fn from_pid(pid: u16) -> Option<Self> {
        match pid {
            DS4_V1_PID | DS4_V2_PID | DS4_PS3_PID => Some(Self::Ds4),
            DUALSENSE_PID => Some(Self::DualSense),
            DUALSENSE_EDGE_PID => Some(Self::DualSenseEdge),
            _ => None,
        }
    }

    pub fn kind(self) -> &'static str {
        match self {
            Self::Ds4 => "ds4",
            Self::DualSense => "dualsense",
            Self::DualSenseEdge => "dualsense-edge",
        }
    }

    pub fn is_ds5(self) -> bool {
        matches!(self, Self::DualSense | Self::DualSenseEdge)
    }

    pub fn has_player_leds(self) -> bool {
        self.is_ds5()
    }

    pub fn has_mic_led(self) -> bool {
        self.is_ds5()
    }

    pub fn has_trigger_effects(self) -> bool {
        self.is_ds5()
    }

    /// Third-party clones need quirk flags; genuine Sony PIDs get none.
    pub fn quirks(self, _vid: u16, _pid: u16) -> Quirks {
        Quirks::default()
    }
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Usb => "usb",
            Self::Bluetooth => "bt",
        }
    }
}
