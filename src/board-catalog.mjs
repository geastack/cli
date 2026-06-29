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
