#!/usr/bin/env swift

import CoreBluetooth
import Darwin
import Foundation

// `gea` runs this helper with stdout connected to a pipe. Disable stdio
// buffering so discovery, transport selection, and percentage updates remain
// visible during a long first update from older firmware.
setbuf(stdout, nil)

private let otaService = CBUUID(string: "7F2E1001-6D8F-4A4F-A0E9-5B8892140001")
private let otaControl = CBUUID(string: "7F2E1001-6D8F-4A4F-A0E9-5B8892140002")
private let otaData = CBUUID(string: "7F2E1001-6D8F-4A4F-A0E9-5B8892140003")

private func u32le(_ value: UInt32) -> [UInt8] {
    [
        UInt8(truncatingIfNeeded: value),
        UInt8(truncatingIfNeeded: value >> 8),
        UInt8(truncatingIfNeeded: value >> 16),
        UInt8(truncatingIfNeeded: value >> 24),
    ]
}

private func readU32le(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    UInt32(bytes[offset])
        | (UInt32(bytes[offset + 1]) << 8)
        | (UInt32(bytes[offset + 2]) << 16)
        | (UInt32(bytes[offset + 3]) << 24)
}

private func controlPacket(opcode: UInt8, imageSize: UInt32? = nil) -> Data {
    var bytes = [opcode]
    if let imageSize { bytes.append(contentsOf: u32le(imageSize)) }
    return Data(bytes)
}

private final class BleOtaUpdater: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let image: Data
    private let deviceName: String
    private let statusOnly: Bool
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var controlCharacteristic: CBCharacteristic?
    private var dataCharacteristic: CBCharacteristic?
    private var offset = 0
    private var lastPrintedPercent = -1
    private var sentFinish = false
    private var finished = false
    private var timeout: Timer?
    private var transferStartedAt: Date?

    init(image: Data, deviceName: String, statusOnly: Bool = false) {
        self.image = image
        self.deviceName = deviceName
        self.statusOnly = statusOnly
        super.init()
    }

    func start() {
        print("Looking for \(deviceName)…")
        central = CBCentralManager(delegate: self, queue: .main)
        // Give discovery, transfer, flash validation, and reboot a bounded
        // window. Data always uses CoreBluetooth's no-response flow control.
        let timeoutSeconds = statusOnly ? 30 : max(300, Double(image.count) / 2048)
        timeout = Timer.scheduledTimer(withTimeInterval: timeoutSeconds, repeats: false) { [weak self] _ in
            self?.fail("Timed out waiting for the BLE update to complete.")
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state == .unsupported || central.state == .unauthorized || central.state == .poweredOff {
                fail("Bluetooth is unavailable (state \(central.state.rawValue)).")
            }
            return
        }
        // Bonded BLE peripherals may already be connected by macOS (for example
        // because the firmware exposes a battery service). Connected peripherals
        // no longer produce scan results, so claim an existing OTA connection
        // before starting discovery.
        if let connected = central.retrieveConnectedPeripherals(withServices: [otaService]).first {
            connect(connected, advertisedName: connected.name)
            return
        }
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    private func connect(_ peripheral: CBPeripheral, advertisedName: String?) {
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        print("Connecting to \(advertisedName ?? peripheral.name ?? deviceName)…")
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let advertisedServices = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let nameMatches = peripheral.name?.localizedCaseInsensitiveContains(deviceName) == true
            || advertisedName?.localizedCaseInsensitiveContains(deviceName) == true
        guard nameMatches || advertisedServices.contains(otaService) else { return }

        connect(peripheral, advertisedName: advertisedName)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        fail("Could not connect: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        if !finished { fail("The board disconnected before the update completed: \(error?.localizedDescription ?? "no reason reported")") }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("Connected. Discovering the OTA service…")
        peripheral.discoverServices([otaService])
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { return fail("Service discovery failed: \(error.localizedDescription)") }
        guard let service = peripheral.services?.first(where: { $0.uuid == otaService }) else {
            return fail("The board does not expose the Geastack OTA service. Flash a BLE-OTA-enabled app over USB first.")
        }
        peripheral.discoverCharacteristics([otaControl, otaData], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        if let error { return fail("Characteristic discovery failed: \(error.localizedDescription)") }
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == otaControl { controlCharacteristic = characteristic }
            if characteristic.uuid == otaData { dataCharacteristic = characteristic }
        }
        guard let controlCharacteristic, dataCharacteristic != nil else {
            return fail("The OTA service is incomplete on this firmware.")
        }
        peripheral.setNotifyValue(true, for: controlCharacteristic)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error { return fail("Could not subscribe to OTA status: \(error.localizedDescription)") }
        guard characteristic.uuid == otaControl, characteristic.isNotifying else { return }
        if statusOnly {
            peripheral.writeValue(controlPacket(opcode: 0x05), for: characteristic, type: .withResponse)
            return
        }
        guard image.count <= Int(UInt32.max) else { return fail("Firmware image is too large for the OTA protocol.") }
        print("Starting encrypted transfer of \(image.count) bytes…")
        transferStartedAt = Date()
        peripheral.writeValue(controlPacket(opcode: 0x01, imageSize: UInt32(image.count)),
                              for: characteristic, type: .withResponse)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error { return fail("OTA status read failed: \(error.localizedDescription)") }
        guard characteristic.uuid == otaControl, let value = characteristic.value else { return }
        let bytes = [UInt8](value)
        guard bytes.count == 10 || bytes.count == 18 else { return fail("The board returned a malformed OTA status packet.") }
        let opcode = bytes[0]
        if opcode == 0x85 {
            let error = Int32(bitPattern: readU32le(bytes, 2))
            finished = true
            timeout?.invalidate()
            var details = "Wi-Fi BLE status: state=\(bytes[1]) error=\(error) enabled=\(bytes[6]) connected=\(bytes[7])"
            if bytes.count == 18 && bytes[9] == 0xa5 {
                let otaError = Int32(bitPattern: readU32le(bytes, 10))
                details += " ota-started=\(bytes[8]) ota-error=\(otaError) live-dma-free=\(readU32le(bytes, 14))"
            } else if bytes.count == 18 {
                details += " dma-free=\(readU32le(bytes, 10)) dma-largest=\(readU32le(bytes, 14))"
            }
            print(details)
            exit(EXIT_SUCCESS)
        }
        let result = bytes[1]
        let received = readU32le(bytes, 2)
        let expected = readU32le(bytes, 6)
        guard result == 0 else {
            return fail("The board rejected OTA command 0x\(String(opcode & 0x7f, radix: 16)) (result \(result), \(received)/\(expected) bytes).")
        }

        if opcode == 0x81 {
            sendNextChunk(peripheral)
        } else if opcode == 0x82 {
            guard received == 0 && expected == 0 else {
                return fail("The board completed OTA with unexpected residual state \(received)/\(expected).")
            }
            finished = true
            timeout?.invalidate()
            let elapsed = max(0.001, Date().timeIntervalSince(transferStartedAt ?? Date()))
            let kibPerSecond = Double(image.count) / elapsed / 1024
            let mibPerSecond = kibPerSecond / 1024
            print(String(format: "BLE OTA complete in %.2fs (%.3f MiB/s, %.1f KiB/s). The board is rebooting into the new firmware.", elapsed, mibPerSecond, kibPerSecond))
            exit(EXIT_SUCCESS)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error { return fail("BLE write failed: \(error.localizedDescription)") }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        sendNextChunk(peripheral)
    }

    private func sendNextChunk(_ peripheral: CBPeripheral) {
        guard let dataCharacteristic, let controlCharacteristic else { return }
        if offset == image.count {
            guard !sentFinish else { return }
            sentFinish = true
            print("\nValidating firmware…")
            peripheral.writeValue(controlPacket(opcode: 0x02), for: controlCharacteristic, type: .withResponse)
            return
        }
        // OTA has its own BEGIN/FINISH control acknowledgements. Sending DATA as
        // ATT write commands is correct even when a bonded CoreBluetooth cache
        // still reports the flags from older firmware; waiting for an ATT write
        // response per chunk makes a full image take many minutes.
        let writeType: CBCharacteristicWriteType = .withoutResponse
        let maximum = min(512, peripheral.maximumWriteValueLength(for: writeType))
        guard maximum > 0 else { return fail("CoreBluetooth reported an invalid write size.") }
        if offset == 0 {
            print("BLE OTA data: write without response, \(maximum)-byte chunks")
        }
        while offset < image.count && peripheral.canSendWriteWithoutResponse {
            let length = min(maximum, image.count - offset)
            let chunk = image.subdata(in: offset..<(offset + length))
            peripheral.writeValue(chunk, for: dataCharacteristic, type: writeType)
            offset += length
            printProgress()
        }
        if offset == image.count { sendNextChunk(peripheral) }
    }

    private func printProgress() {
        let percent = image.isEmpty ? 100 : (offset * 100 / image.count)
        guard percent != lastPrintedPercent else { return }
        lastPrintedPercent = percent
        print("Transferred \(offset)/\(image.count) bytes (\(percent)%)")
    }

    private func fail(_ message: String) {
        guard !finished else { return }
        finished = true
        timeout?.invalidate()
        if let peripheral, let controlCharacteristic {
            peripheral.writeValue(controlPacket(opcode: 0x03), for: controlCharacteristic, type: .withResponse)
        }
        fputs("ERROR: \(message)\n", stderr)
        exit(EXIT_FAILURE)
    }
}

if CommandLine.arguments.dropFirst().first == "--self-test" {
    precondition([UInt8](controlPacket(opcode: 0x01, imageSize: 0x78563412)) == [1, 0x12, 0x34, 0x56, 0x78])
    precondition(readU32le([0, 0, 0x12, 0x34, 0x56, 0x78], 2) == 0x78563412)
    print("BLE OTA protocol self-test passed")
    exit(EXIT_SUCCESS)
}

private let updater: BleOtaUpdater = {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.first == "--wifi-status" {
        guard arguments.count <= 2 else {
            fputs("Usage: ble-ota.swift --wifi-status [device name]\n", stderr)
            exit(EXIT_FAILURE)
        }
        return BleOtaUpdater(
            image: Data(),
            deviceName: arguments.count == 2 ? arguments[1] : "Geastack OTA",
            statusOnly: true)
    }
    guard arguments.count == 1 || arguments.count == 2 else {
        fputs("Usage: ble-ota.swift <firmware.bin> [device name]\n", stderr)
        exit(EXIT_FAILURE)
    }
    let imagePath = arguments[0]
    guard let image = FileManager.default.contents(atPath: imagePath), !image.isEmpty else {
        fputs("ERROR: Could not read firmware image at \(imagePath)\n", stderr)
        exit(EXIT_FAILURE)
    }
    return BleOtaUpdater(image: image, deviceName: arguments.count == 2 ? arguments[1] : "Geastack OTA")
}()
updater.start()
RunLoop.main.run()
