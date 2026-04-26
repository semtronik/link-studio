({
  name: "Demo IoT",
  version: "1.0.0",
  description: "Demo protocol: Status, ACK, Temperature",

  // Frame format:
  // | TypeSeq (1) | Dest (1) | Src (1) | Payload (variable) | CRC16 (2) |
  //
  // TypeSeq: [ TTT SSSSS ]
  //   TTT   = type (3 bits)  : 1=Status, 2=ACK, 3=Temperature
  //   SSSSS = seq  (5 bits)  : 0-31, rollover
  //
  // Payload by type:
  //   Status (1)      : 2 bytes — battery voltage (mV, big-endian)
  //   ACK (2)         : 1 byte  — seq of the acknowledged message
  //   Temperature (3) : 2 bytes — signed temperature x100 (big-endian)
  //
  // CRC16: sum of preceding bytes, truncated to 16 bits (big-endian)

  decode(hex) {
    const len = hex.length / 2;
    if (len < 4) {
      return { fields: [{ name: "Error", value: "Frame too short", bytes: [0, len], color: "red" }] };
    }

    const byte0 = parseInt(hex.slice(0, 2), 16);
    const type = (byte0 >> 5) & 0x07;
    const seq = byte0 & 0x1F;
    const dest = parseInt(hex.slice(2, 4), 16);
    const src = parseInt(hex.slice(4, 6), 16);

    const TYPE_NAMES = { 1: "STATUS", 2: "ACK", 3: "TEMP" };
    const typeName = TYPE_NAMES[type] || "UNKNOWN";

    const fields = [
      { name: "Type",  value: typeName, bytes: [0, 1], color: "blue" },
      { name: "Seq",   value: seq,      bytes: [0, 1], color: "blue" },
      { name: "Dest",  value: "0x" + hex.slice(2, 4), bytes: [1, 2], color: "purple" },
      { name: "Src",   value: "0x" + hex.slice(4, 6), bytes: [2, 3], color: "purple" },
    ];

    let summary = typeName + " #" + seq + " " + "0x" + hex.slice(4, 6) + "→0x" + hex.slice(2, 4);
    let payloadEnd = 3; // byte index after src

    if (type === 1 && len >= 7) {
      // Status: battery mV
      const mv = (parseInt(hex.slice(6, 8), 16) << 8) | parseInt(hex.slice(8, 10), 16);
      const volts = (mv / 1000).toFixed(2);
      fields.push({ name: "Battery", value: volts, unit: "V", bytes: [3, 5], color: "green" });
      summary += " bat=" + volts + "V";
      payloadEnd = 5;

    } else if (type === 2 && len >= 6) {
      // ACK: acknowledged seq
      const ackSeq = parseInt(hex.slice(6, 8), 16);
      fields.push({ name: "ACK seq", value: ackSeq, bytes: [3, 4], color: "yellow" });
      summary += " ack=#" + ackSeq;
      payloadEnd = 4;

    } else if (type === 3 && len >= 7) {
      // Temperature: signed x100
      let raw = (parseInt(hex.slice(6, 8), 16) << 8) | parseInt(hex.slice(8, 10), 16);
      if (raw > 0x7FFF) raw -= 0x10000;
      const temp = (raw / 100).toFixed(2);
      fields.push({ name: "Temperature", value: temp, unit: "°C", bytes: [3, 5], color: "green" });
      summary += " T=" + temp + "°C";
      payloadEnd = 5;
    }

    // CRC16 (last 2 bytes)
    if (len >= payloadEnd + 2) {
      const crcStart = payloadEnd;
      const crcHi = parseInt(hex.slice(crcStart * 2, crcStart * 2 + 2), 16);
      const crcLo = parseInt(hex.slice(crcStart * 2 + 2, crcStart * 2 + 4), 16);
      const crcReceived = (crcHi << 8) | crcLo;

      // Expected CRC: sum of bytes before the CRC, truncated to 16 bits
      let crcCalc = 0;
      for (let i = 0; i < crcStart; i++) {
        crcCalc += parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      crcCalc &= 0xFFFF;

      const ok = crcReceived === crcCalc;
      fields.push({
        name: "CRC",
        value: ok ? "OK" : "ERROR (got 0x" + crcReceived.toString(16).toUpperCase() + ", expected 0x" + crcCalc.toString(16).toUpperCase() + ")",
        bytes: [crcStart, crcStart + 2],
        color: ok ? "gray" : "red"
      });
      if (!ok) summary += " [CRC!]";
    }

    return {
      fields,
      meta: { type, seq, src, dest },
      summary,
    };
  }
})
