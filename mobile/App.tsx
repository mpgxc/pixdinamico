/**
 * Raiz do app.
 *
 * A permissão de câmera é pedida por um toque, e não na abertura: um diálogo de
 * sistema surgindo sozinho é a forma mais rápida de o usuário negar sem ler.
 */

import { useEffect } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useCameraPermission } from 'react-native-vision-camera';

import { ScannerScreen } from './src/ui/ScannerScreen.tsx';
import { theme } from './src/ui/theme.ts';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <Gate />
    </SafeAreaProvider>
  );
}

function Gate() {
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();

  // Já autorizado numa sessão anterior: entra direto, sem pedir de novo.
  useEffect(() => {
    if (!hasPermission && canRequestPermission) return;
  }, [hasPermission, canRequestPermission]);

  if (hasPermission) return <ScannerScreen />;

  return (
    <View style={styles.gate}>
      <Text style={styles.title}>Leitor de QR Code</Text>
      <Text style={styles.body}>
        O leitor encontra o código no quadro e aproxima a lente sozinho quando
        ele está pequeno demais para ser lido. Nenhuma imagem sai do aparelho.
      </Text>

      {canRequestPermission ? (
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Permitir a câmera</Text>
        </Pressable>
      ) : (
        <Text style={styles.denied}>
          O acesso à câmera está bloqueado. Libere nas configurações do sistema.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.ink,
    padding: 28,
    gap: 16,
  },
  title: { color: theme.paper, fontSize: 26, fontWeight: '800' },
  body: { color: theme.paper, opacity: 0.75, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  denied: { color: theme.danger, fontSize: 14, textAlign: 'center' },
  button: {
    marginTop: 8,
    backgroundColor: theme.accent,
    borderRadius: theme.radius,
    paddingVertical: 14,
    paddingHorizontal: 28,
  },
  buttonText: { color: theme.ink, fontWeight: '800', fontSize: 15 },
});
