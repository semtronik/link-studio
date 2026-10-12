/** Raw parser source, evaluated in the Web Worker. */
export const RAW_PARSER_CODE = `({
  name: "Raw",
  version: "1.0.0",
  description: "Shows raw data without decoding",
  decode(hex) {
    const byteCount = Math.floor(hex.length / 2);
    return {
      fields: [{
        name: "Data",
        value: hex.match(/.{1,2}/g)?.join(" ") || hex,
        bytes: [0, byteCount],
        color: "gray"
      }],
      summary: byteCount + " byte" + (byteCount !== 1 ? "s" : "")
    };
  }
})`;
