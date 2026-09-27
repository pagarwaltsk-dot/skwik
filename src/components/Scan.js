import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Modal, Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { C, S } from '../theme';

// THE BARCODE ON THE PACKET.
//
// A shop with eight hundred lines cannot find an item by typing its name, and
// every app he might buy instead can scan. This is the whole of it: open the
// camera, read the stripes, hand the number back.
//
// It is deliberately dumb. What that number MEANS — which item it is, whether
// it is on the bill already — is decided by whoever opened it.

const KINDS = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93',
               'itf14', 'codabar', 'qr'];

export function ScanSheet({ visible, onClose, onCode, title = 'Point at the barcode', note }) {
  const [permission, ask] = useCameraPermissions();

  // THE SAME PACKET, SCANNED AGAIN.
  //
  // The camera fires many times a second, so one reading has to be turned into
  // one item — and the way that was done was to remember the last code and
  // ignore it FOR EVER. Which broke the two things this sheet is for:
  //
  //   * "scan the same packet twice and the quantity goes up" — printed on
  //     this very screen — could not happen, because the second scan of the
  //     same packet was the code it was ignoring.
  //   * a code nothing carries put up "add it to an item now?", and if he came
  //     back and scanned that packet again the camera sat there doing nothing
  //     at all, because the sheet had been closed without being reset.
  //
  // So a repeat is only ignored for a moment — long enough for the twenty
  // frames of one wave of the packet, not long enough to stop him scanning it
  // again on purpose. And it forgets everything each time the sheet opens.
  const last = useRef({ code: '', at: 0 });
  const SAME_AGAIN_MS = 1200;

  useEffect(() => { if (visible) last.current = { code: '', at: 0 }; }, [visible]);

  const got = ({ data }) => {
    const code = String(data || '').trim();
    if (!code) return;
    const now = Date.now();
    if (code === last.current.code && now - last.current.at < SAME_AGAIN_MS) return;
    last.current = { code, at: now };
    onCode(code);
  };

  const close = () => { last.current = { code: '', at: 0 }; onClose(); };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {!permission ? null : !permission.granted ? (
          <View style={{ flex: 1, justifyContent: 'center', padding: 28 }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: '#fff' }}>
              Skwik needs the camera
            </Text>
            <Text style={{ fontSize: 14, color: '#fff', opacity: 0.8, marginTop: 10, lineHeight: 21 }}>
              Only to read barcodes while you bill. Nothing is photographed and
              nothing leaves this phone.
            </Text>
            <TouchableOpacity style={[S.btn, { marginTop: 24 }]}
              onPress={() => (permission.canAskAgain ? ask() : Linking.openSettings())}>
              <Text style={S.btnText}>
                {permission.canAskAgain ? 'Allow the camera' : 'Open settings'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={close} style={{ marginTop: 16, alignItems: 'center', padding: 10 }}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', opacity: 0.8 }}>
                Not now
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: KINDS }}
              onBarcodeScanned={got}
            />
            {/* the window to hold the packet in */}
            <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0,
                                                top: 0, bottom: 0, alignItems: 'center',
                                                justifyContent: 'center' }}>
              <View style={{ width: '78%', height: 150, borderWidth: 2.5,
                             borderColor: '#FFFFFFCC', borderRadius: 14 }} />
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 18 }}>
                {title}
              </Text>
              {!!note && (
                <Text style={{ color: '#fff', opacity: 0.85, fontSize: 13, marginTop: 6 }}>
                  {note}
                </Text>
              )}
            </View>
            <TouchableOpacity onPress={close}
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0,
                       paddingVertical: 22, alignItems: 'center',
                       backgroundColor: '#000000AA' }}>
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800' }}>Done</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </Modal>
  );
}

// The small button that opens it, so every screen offers the same thing.
export function ScanButton({ onPress, light = false, label = 'SCAN' }) {
  return (
    <TouchableOpacity onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={{ paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ fontSize: 14, fontWeight: '800',
                     color: light ? '#fff' : C.accent, opacity: light ? 0.9 : 1 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}
