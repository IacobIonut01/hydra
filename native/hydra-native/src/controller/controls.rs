//! Canonical control ids (DS4Windows `DS4Controls` vocabulary) and the u64
//! pressed-bitmask helpers shared by parsers, remap and the napi boundary.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[repr(u8)]
pub enum Ds4Control {
    Square = 0,
    Cross,
    Circle,
    Triangle,
    DpadUp,
    DpadDown,
    DpadLeft,
    DpadRight,
    L1,
    R1,
    L2,
    R2,
    L3,
    R3,
    Share,
    Options,
    Ps,
    TouchClick,
    Mute,
    FnL,
    FnR,
    PaddleLeft,
    PaddleRight,
    LxUp,
    LxDown,
    LxLeft,
    LxRight,
    RxUp,
    RxDown,
    RxLeft,
    RxRight,
    L2Full,
    R2Full,
    GyroXP,
    GyroXN,
    GyroYP,
    GyroYN,
    GyroZP,
    GyroZN,
}

pub const ALL_CONTROLS: [Ds4Control; 39] = [
    Ds4Control::Square,
    Ds4Control::Cross,
    Ds4Control::Circle,
    Ds4Control::Triangle,
    Ds4Control::DpadUp,
    Ds4Control::DpadDown,
    Ds4Control::DpadLeft,
    Ds4Control::DpadRight,
    Ds4Control::L1,
    Ds4Control::R1,
    Ds4Control::L2,
    Ds4Control::R2,
    Ds4Control::L3,
    Ds4Control::R3,
    Ds4Control::Share,
    Ds4Control::Options,
    Ds4Control::Ps,
    Ds4Control::TouchClick,
    Ds4Control::Mute,
    Ds4Control::FnL,
    Ds4Control::FnR,
    Ds4Control::PaddleLeft,
    Ds4Control::PaddleRight,
    Ds4Control::LxUp,
    Ds4Control::LxDown,
    Ds4Control::LxLeft,
    Ds4Control::LxRight,
    Ds4Control::RxUp,
    Ds4Control::RxDown,
    Ds4Control::RxLeft,
    Ds4Control::RxRight,
    Ds4Control::L2Full,
    Ds4Control::R2Full,
    Ds4Control::GyroXP,
    Ds4Control::GyroXN,
    Ds4Control::GyroYP,
    Ds4Control::GyroYN,
    Ds4Control::GyroZP,
    Ds4Control::GyroZN,
];

impl Ds4Control {
    pub fn bit(self) -> u64 {
        1u64 << (self as u8)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Square => "square",
            Self::Cross => "cross",
            Self::Circle => "circle",
            Self::Triangle => "triangle",
            Self::DpadUp => "dpadUp",
            Self::DpadDown => "dpadDown",
            Self::DpadLeft => "dpadLeft",
            Self::DpadRight => "dpadRight",
            Self::L1 => "l1",
            Self::R1 => "r1",
            Self::L2 => "l2",
            Self::R2 => "r2",
            Self::L3 => "l3",
            Self::R3 => "r3",
            Self::Share => "share",
            Self::Options => "options",
            Self::Ps => "ps",
            Self::TouchClick => "touchClick",
            Self::Mute => "mute",
            Self::FnL => "fnL",
            Self::FnR => "fnR",
            Self::PaddleLeft => "paddleLeft",
            Self::PaddleRight => "paddleRight",
            Self::LxUp => "lxUp",
            Self::LxDown => "lxDown",
            Self::LxLeft => "lxLeft",
            Self::LxRight => "lxRight",
            Self::RxUp => "rxUp",
            Self::RxDown => "rxDown",
            Self::RxLeft => "rxLeft",
            Self::RxRight => "rxRight",
            Self::L2Full => "l2Full",
            Self::R2Full => "r2Full",
            Self::GyroXP => "gyroXPos",
            Self::GyroXN => "gyroXNeg",
            Self::GyroYP => "gyroYPos",
            Self::GyroYN => "gyroYNeg",
            Self::GyroZP => "gyroZPos",
            Self::GyroZN => "gyroZNeg",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        ALL_CONTROLS
            .iter()
            .copied()
            .find(|control| control.name() == name)
    }
}

pub fn set(mask: &mut u64, control: Ds4Control, value: bool) {
    if value {
        *mask |= control.bit();
    } else {
        *mask &= !control.bit();
    }
}

pub fn get(mask: u64, control: Ds4Control) -> bool {
    mask & control.bit() != 0
}

/// DS4 hat nibble (byte 5 low nibble): 0-7 clockwise from up, >=8 neutral.
pub fn dpad_bits(hat: u8) -> u64 {
    use Ds4Control::*;
    match hat & 0x0F {
        0 => DpadUp.bit(),
        1 => DpadUp.bit() | DpadRight.bit(),
        2 => DpadRight.bit(),
        3 => DpadRight.bit() | DpadDown.bit(),
        4 => DpadDown.bit(),
        5 => DpadDown.bit() | DpadLeft.bit(),
        6 => DpadLeft.bit(),
        7 => DpadLeft.bit() | DpadUp.bit(),
        _ => 0,
    }
}
