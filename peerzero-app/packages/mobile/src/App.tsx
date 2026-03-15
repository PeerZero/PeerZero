// =============================================================================
// PeerZero Mobile App — Root component
// =============================================================================

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthContext, useAuthProvider } from './hooks/useAuth';
import { usePushNotifications } from './hooks/usePushNotifications';
import AppNavigator from './navigation/AppNavigator';

export default function App() {
  const auth = useAuthProvider();

  // Register push notifications when authenticated
  usePushNotifications(auth.isAuthenticated);

  return (
    <SafeAreaProvider>
      <AuthContext.Provider value={auth}>
        <StatusBar style="light" />
        <AppNavigator />
      </AuthContext.Provider>
    </SafeAreaProvider>
  );
}
