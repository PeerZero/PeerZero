// =============================================================================
// usePushNotifications — registers Expo push token with the server
//
// Called once from App.tsx after authentication. Handles:
// - Permission request (respects user's OS-level choice)
// - Token registration with the server
// - Token cleanup on logout
//
// Scaling: Each device gets one token. Tokens are cleaned up server-side
// when Expo returns DeviceNotRegistered. No polling or background tasks.
// =============================================================================

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { notifications as notifApi } from '../services/api';

// Push notifications are not supported on web
if (Platform.OS !== 'web') {
  const Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export function usePushNotifications(isAuthenticated: boolean): void {
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    // Push notifications are not supported on web
    if (Platform.OS === 'web') return;

    if (!isAuthenticated) {
      // Clean up token on logout
      if (tokenRef.current) {
        notifApi.removeToken(tokenRef.current).catch(() => {});
        tokenRef.current = null;
      }
      return;
    }

    const Notifications = require('expo-notifications');
    const Device = require('expo-device');

    // Only register on real devices (not simulators)
    if (!Device.isDevice) return;

    (async () => {
      try {
        // Check/request permissions
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== 'granted') return;

        // Android needs a notification channel
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'PeerZero',
            importance: Notifications.AndroidImportance.DEFAULT,
            vibrationPattern: [0, 250, 250, 250],
          });
        }

        // Get the Expo push token
        const tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: undefined, // Uses app.json expo.extra.eas.projectId
        });

        const token = tokenData.data;
        tokenRef.current = token;

        // Register with our server
        await notifApi.registerToken(token, Device.deviceName || undefined);
      } catch {
        // Push registration is best-effort — don't crash the app
      }
    })();
  }, [isAuthenticated]);
}
