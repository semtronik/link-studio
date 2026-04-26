use crate::lora_protocol::{FrameData, FrameStats};
use std::collections::VecDeque;

const MAX_FRAMES: usize = 500;
// F4: recalibrer frequemment pour limiter la derive floating-point
const RECALIBRATE_INTERVAL: usize = 50;

pub struct FrameStore {
    frames: VecDeque<FrameData>,
    rssi_sum: f64,
    rssi_count: usize,
    snr_sum: f64,
    snr_count: usize,
    push_count: usize,
}

impl FrameStore {
    pub fn new() -> Self {
        Self {
            frames: VecDeque::with_capacity(MAX_FRAMES),
            rssi_sum: 0.0,
            rssi_count: 0,
            snr_sum: 0.0,
            snr_count: 0,
            push_count: 0,
        }
    }

    pub fn push(&mut self, frame: FrameData) {
        if self.frames.len() >= MAX_FRAMES {
            if let Some(old) = self.frames.pop_front() {
                if let Some(rssi) = old.rssi {
                    self.rssi_sum -= rssi;
                    self.rssi_count -= 1;
                }
                if let Some(snr) = old.snr {
                    self.snr_sum -= snr;
                    self.snr_count -= 1;
                }
            }
        }

        if let Some(rssi) = frame.rssi {
            self.rssi_sum += rssi;
            self.rssi_count += 1;
        }
        if let Some(snr) = frame.snr {
            self.snr_sum += snr;
            self.snr_count += 1;
        }

        self.frames.push_back(frame);

        self.push_count += 1;
        if self.push_count % RECALIBRATE_INTERVAL == 0 {
            self.recalibrate();
        }
    }

    pub fn stats(&self) -> FrameStats {
        FrameStats {
            count: self.frames.len(),
            avg_rssi: if self.rssi_count > 0 {
                Some(self.rssi_sum / self.rssi_count as f64)
            } else {
                None
            },
            avg_snr: if self.snr_count > 0 {
                Some(self.snr_sum / self.snr_count as f64)
            } else {
                None
            },
        }
    }

    pub fn frames(&self) -> Vec<FrameData> {
        self.frames.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.frames.clear();
        self.rssi_sum = 0.0;
        self.rssi_count = 0;
        self.snr_sum = 0.0;
        self.snr_count = 0;
        self.push_count = 0;
    }

    pub fn load(&mut self, frames: Vec<FrameData>) {
        self.clear();
        for frame in frames {
            self.push(frame);
        }
    }

    fn recalibrate(&mut self) {
        self.rssi_sum = 0.0;
        self.rssi_count = 0;
        self.snr_sum = 0.0;
        self.snr_count = 0;
        for frame in &self.frames {
            if let Some(rssi) = frame.rssi {
                self.rssi_sum += rssi;
                self.rssi_count += 1;
            }
            if let Some(snr) = frame.snr {
                self.snr_sum += snr;
                self.snr_count += 1;
            }
        }
    }
}
