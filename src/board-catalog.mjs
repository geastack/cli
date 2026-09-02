export const knownBoards = Object.freeze([
  {
    id: 'waveshare-amoled-206',
    label: 'Waveshare ESP32-S3 Touch AMOLED 2.06',
    alias: 'amoled',
    target: 'esp32-s3-touch-amoled-2.06',
    adapter: 'esp32-idf',
    mcu: 'ESP32-S3',
    capabilities: {
      display: '2.06 inch AMOLED touch panel',
      touch: 'board integrated touch',
      wireless: ['WiFi', 'BLE'],
      storage: ['flash', 'PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'waveshare-amoled-18',
    label: 'Waveshare ESP32-S3 Touch AMOLED 1.8',
    alias: 'amoled-18',
    target: 'esp32-s3-touch-amoled-1.8',
    adapter: 'esp32-idf',
    mcu: 'ESP32-S3',
    capabilities: {
      display: '1.8 inch AMOLED touch panel',
      touch: 'board integrated touch',
      wireless: ['WiFi', 'BLE'],
      storage: ['flash', 'PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'lilygo-t-display-s3-long',
    label: 'LILYGO T-Display-S3 Long',
    alias: 't-display-long',
    target: 'esp32-s3-lilygo-t-display-s3-long',
    adapter: 'esp32-idf',
    mcu: 'ESP32-S3R8',
    capabilities: {
      display: '3.4 inch 180x640 AMOLED (AXS15231B)',
      touch: 'capacitive touch hardware (target driver pending)',
      wireless: ['WiFi', 'BLE'],
      storage: ['16 MB flash', '8 MB PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'waveshare-amoled-175',
    label: 'Waveshare ESP32-S3 Touch AMOLED 1.75',
    alias: 'amoled-175',
    target: 'esp32-s3-touch-amoled-1.75',
    adapter: 'esp32-idf',
    mcu: 'ESP32-S3',
    capabilities: {
      display: '1.75 inch AMOLED touch panel',
      touch: 'board integrated touch',
      wireless: ['WiFi', 'BLE'],
      storage: ['flash', 'PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'esp32-s3-epaper-154',
    label: 'ESP32-S3 e-paper 1.54',
    alias: 'epaper',
    target: 'esp32-s3-epaper-1.54',
    adapter: 'esp32-idf',
    mcu: 'ESP32-S3',
    capabilities: {
      display: '1.54 inch e-paper',
      touch: 'none',
      wireless: ['WiFi', 'BLE'],
      storage: ['flash'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'elecrow-rotary-21',
    label: 'Elecrow ESP32-S3 Rotary 2.1',
    alias: 'rotary',
    target: 'esp32-s3-elecrow-rotary-2.1',
    adapter: 'esp32-idf',
    mcu: 'ESP32-S3',
    capabilities: {
      display: '2.1 inch round display',
      touch: 'rotary/input board controls',
      wireless: ['WiFi', 'BLE'],
      storage: ['flash', 'PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'waveshare-p4-lcd-7',
    label: 'Waveshare ESP32-P4 Touch LCD 7',
    alias: 'waveshare-p4-7',
    target: 'esp32-p4-waveshare-touch-lcd-7',
    adapter: 'esp32-idf',
    mcu: 'ESP32-P4',
    capabilities: {
      display: '7 inch RGB touch LCD',
      touch: 'board integrated touch',
      wireless: [],
      storage: ['flash', 'PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'm5stack-tab5',
    label: 'M5Stack Tab5',
    alias: 'm5tab',
    target: 'esp32-p4-m5stack-tab5',
    adapter: 'esp32-idf',
    mcu: 'ESP32-P4 + ESP32-C6',
    capabilities: {
      display: '5 inch 1280x720 IPS touch panel (ST7123/ST7121 current, ILI9881C legacy)',
      touch: 'GT911 or ST7123/ST7121 integrated touch',
      wireless: ['ESP32-C6 WiFi 6', 'BLE/Thread/Zigbee capable'],
      storage: ['16 MB flash', '32 MB PSRAM', 'microSD'],
      audio: ['ES8388 codec', 'ES7210 dual-mic AEC', 'NS4150B 1W speaker', '3.5mm headphone'],
      gps: false,
      sensors: ['BMI270 IMU', 'RX8130CE RTC', 'INA226 power monitor', 'IP2326 charger', 'PI4IOE5V6408 IO expanders', 'SC2356 camera', 'SIT3088 RS485']
    }
  },
  {
    id: 'waveshare-p4-lcd-35',
    label: 'Waveshare ESP32-P4 Touch LCD 3.5',
    alias: 'waveshare-p4-3.5',
    target: 'esp32-p4-waveshare-touch-lcd-3.5',
    adapter: 'esp32-idf',
    mcu: 'ESP32-P4',
    capabilities: {
      display: '3.5 inch RGB touch LCD',
      touch: 'board integrated touch',
      wireless: [],
      storage: ['flash', 'PSRAM'],
      audio: [],
      gps: false
    }
  },
  {
    id: 'waveshare-rp2350-amoled-241',
    label: 'Waveshare RP2350 Touch AMOLED 2.41',
    alias: 'waveshare-rp2350-amoled-2.41',
    target: 'rp2350-waveshare-touch-amoled-2.41',
    adapter: 'rp2350-pico',
    mcu: 'RP2350',
    capabilities: {
      display: '2.41 inch 450x600 AMOLED touch panel (RM690B0)',
      touch: 'FT6336 capacitive touch',
      wireless: [],
      storage: ['16 MB flash', '2 MB PSRAM'],
      audio: [],
      gps: false,
      sensors: ['QMI8658 IMU', 'PCF85063 RTC', 'ETA6098 power']
    }
  },
  {
    id: 'pimoroni-tufty-2350',
    label: 'Pimoroni Tufty 2350',
    alias: 'tufty-2350',
    target: 'rp2350-tufty-2350',
    adapter: 'rp2350-pico',
    mcu: 'RP2350',
    capabilities: {
      display: '2.8 inch 320x240 IPS LCD (ST7789 parallel)',
      touch: 'none',
      wireless: ['WiFi', 'BLE'],
      storage: ['16 MB flash', '8 MB PSRAM'],
      audio: [],
      gps: false,
      sensors: ['PCF85063 RTC', 'buttons', 'battery sense', 'rear lighting']
    }
  }
])

export const customBoardDefaults = Object.freeze({
  targetFamily: 'esp32',
  adapter: 'esp32-idf',
  baseTarget: '',
  mcu: '',
  display: {
    kind: '',
    controller: '',
    interface: '',
    resolution: ''
  },
  touch: {
    controller: '',
    interface: ''
  },
  wireless: {
    wifi: '',
    ble: ''
  },
  gps: {
    module: '',
    interface: ''
  },
  audio: {
    codec: '',
    output: '',
    input: ''
  },
  storage: [],
  sensors: [],
  power: '',
  transports: {},
  notes: ''
})

export function boardById(id) {
  return knownBoards.find((board) => board.id === id) || null
}

export function boardByTarget(target) {
  return knownBoards.find((board) => board.target === target) || null
}
