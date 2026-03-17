// =============================================================================
// PeerZero Mobile App — Root component
// =============================================================================

import React from 'react';
import { View, Text, Platform } from 'react-native';

// Temporary: render a simple test on web to confirm rendering works
export default function App() {
  if (Platform.OS === 'web') {
    return (
      <View style={{ flex: 1, backgroundColor: '#0A0E1A', justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#6C5CE7', fontSize: 32, fontWeight: '700' }}>PeerZero</Text>
        <Text style={{ color: '#8B93A8', fontSize: 16, marginTop: 8 }}>Web test — if you see this, rendering works!</Text>
      </View>
    );
  }

  // Normal native app
  const { StatusBar } = require('expo-status-bar');
  const { SafeAreaProvider } = require('react-native-safe-area-context');
  const { AuthContext, useAuthProvider } = require('./hooks/useAuth');
  const { usePushNotifications } = require('./hooks/usePushNotifications');
  const AppNavigator = require('./navigation/AppNavigator').default;
  const ErrorBoundary = require('./components/ErrorBoundary').default;

  const auth = useAuthProvider();
  usePushNotifications(auth.isAuthenticated);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AuthContext.Provider value={auth}>
          <StatusBar style="light" />
          <AppNavigator />
        </AuthContext.Provider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
