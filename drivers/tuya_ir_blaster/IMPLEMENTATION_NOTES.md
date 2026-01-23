# Zosung IR Blaster Implementation Notes

## Implementation Status: ✅ Complete

This driver implements the full Zosung IR protocol based on the zigbee2mqtt (zigbee-herdsman-converters) implementation.

## Protocol Implementation

### Cluster IDs
- **ZosungIRTransmit**: 0xED00 (60672 decimal)
- **ZosungIRControl**: 0xED01 (60673 decimal)

### Multi-Part Transfer Protocol

#### Sending IR Code (Blasting):
1. Hub initiates with `zosungSendIRCode00` (length, seq, metadata)
2. Device responds with `zosungSendIRCode01` (acknowledgment)
3. Device requests chunks with `zosungSendIRCode02` (position, maxlen)
4. Hub sends chunks with `zosungSendIRCode03` (msgpart, CRC)
5. Device confirms completion with `zosungSendIRCode04`
6. Hub finalizes with `zosungSendIRCode05`

**Chunk size when sending: 0x32 (50 bytes)**

#### Learning IR Code (Receiving):
1. Hub sends `zosungControlIRCommand00` with `{study: 0}` to start learning
2. User points remote and presses button
3. Device initiates transfer with `zosungSendIRCode00`
4. Hub acknowledges and requests chunks
5. Device sends chunks via `zosungSendIRCode03Resp`
6. Hub confirms with `zosungSendIRCode04`
7. Device finalizes with `zosungSendIRCode05Resp`
8. Hub sends `zosungControlIRCommand00` with `{study: 1}` to stop learning

**Chunk size when receiving: 0x38 (56 bytes)**

## Key Implementation Details

### CRC Calculation
Two methods are used depending on data type:
- **String CRC**: Sum of character codes % 256
- **Buffer CRC**: Sum of byte values % 256

### IR Code Format
- Stored as **base64** encoded strings
- Transmitted as JSON with structure:
```json
{
  "key_num": 1,
  "delay": 300,
  "key1": {
    "num": 1,
    "freq": 38000,
    "type": 1,
    "key_code": "<base64_ir_code>"
  }
}
```

### Sequence Number Management
- Increments with each transmission (0-65535, wraps at 0x10000)
- Used to track multi-part messages
- Must match across all commands in a transfer

## Differences from Standard Tuya Devices

This device does **NOT** use standard Tuya data points (cluster 0xEF00 / 61184). Instead:
- Uses custom Zosung clusters (0xED00, 0xED01)
- Requires manual multi-part transfer handling
- Base64 encoding instead of raw data points

## Testing Checklist

### Before Testing with Hardware:
- [ ] Device pairs successfully as Zigbee device
- [ ] Clusters 60672 and 60673 are detected
- [ ] Device logs show cluster initialization

### Learning Mode Testing:
- [ ] Activate learning mode via flow card
- [ ] `ir_learning_mode` capability shows true
- [ ] Point remote at blaster and press button
- [ ] Code00 received from device
- [ ] Multi-part transfer completes without CRC errors
- [ ] IR code stored in settings as base64
- [ ] "IR code learned" flow trigger fires
- [ ] Learning mode capability returns to false

### Blasting Mode Testing:
- [ ] Select stored IR code in flow card
- [ ] Code00 sent to device successfully
- [ ] Device requests chunks via Code02
- [ ] All chunks sent with correct CRC
- [ ] Transfer completes with Code05
- [ ] Target device responds to IR signal

### Edge Cases:
- [ ] What happens if learning times out?
- [ ] What happens if user presses learning mode toggle manually?
- [ ] What happens if IR code slot is empty when blasting?
- [ ] Can multiple IR codes be blasted in quick succession?

## Known Limitations

1. **Learning Timeout**: No automatic timeout implemented. If learning fails, user must manually disable learning mode.

2. **Concurrent Operations**: Current implementation doesn't prevent concurrent learning/blasting operations.

3. **IR Code Validation**: No validation that learned IR code is valid before storing.

4. **Settings UI**: All 10 slots always visible (not dynamically hidden based on `number_of_ir_codes` setting).

## Potential Improvements

### 1. Learning Timeout
Add automatic timeout for learning mode:
```javascript
this._learningTimeout = setTimeout(() => {
    this.setCapabilityValue('ir_learning_mode', false);
    this.error('Learning mode timed out');
}, 30000); // 30 seconds
```

### 2. Operation Locking
Prevent concurrent operations:
```javascript
if (this._operationInProgress) {
    throw new Error('Another IR operation is in progress');
}
this._operationInProgress = true;
```

### 3. IR Code Validation
Validate learned codes:
```javascript
if (!irCode || irCode.length < 10) {
    throw new Error('Invalid IR code received');
}
```

### 4. Dynamic Settings
Show/hide IR slots based on `number_of_ir_codes` setting (requires Homey app update hook).

### 5. Error Recovery
Better error handling for failed transfers:
- Retry mechanism for failed chunks
- Cleanup on timeout
- User notification of failures

## Debugging Tips

### Enable Detailed Logging
The device logs all protocol steps. Check Homey logs for:
- "Received IR Code00/01/02/03/04/05"
- "Sent IR Code00/01/02/03/04/05"
- "CRC mismatch" errors
- "Unexpected seq" errors

### Common Issues

**Issue**: Learning mode starts but never completes
- **Check**: Is remote close enough to IR blaster?
- **Check**: Are logs showing Code00 received?
- **Check**: Any CRC errors in logs?

**Issue**: Blasting doesn't control device
- **Check**: Is IR code stored in settings?
- **Check**: Did transfer complete successfully (Code05)?
- **Check**: Is target device in IR range?
- **Check**: Is IR code frequency correct (38kHz)?

**Issue**: "Unexpected seq" errors
- **Check**: Is sequence number incrementing correctly?
- **Check**: Are old transfers being cleaned up?

## References

- [zigbee2mqtt Zosung Implementation](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/lib/zosung.ts)
- [Tuya ZS06 Device](https://github.com/Koenkk/zigbee2mqtt.io/blob/master/docs/devices/ZS06.md)
- [Homey Zigbee Driver Documentation](https://apps-sdk-v3.developer.homey.app/tutorial-zigbee.html)

## Version History

- **v1.0.0** (2026-01-23): Initial implementation
  - Full Zosung protocol support
  - Learning and blasting functionality
  - 10 configurable IR code slots
  - Autocomplete in flow cards
