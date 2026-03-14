// =============================================================================
// App navigator — tab-based navigation with auth gating
// Non-authenticated users see Login/Register. Authenticated users see the main tabs.
// =============================================================================

import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';

// Screens
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import LabScreen from '../screens/LabScreen';
import BotScreen from '../screens/BotScreen';
import BrainScreen from '../screens/BrainScreen';
import LogScreen from '../screens/LogScreen';
import SchoolScreen from '../screens/SchoolScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
    </Stack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg.primary },
        headerTintColor: colors.text.primary,
        tabBarStyle: { backgroundColor: colors.bg.primary, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
      }}
    >
      <Tab.Screen name="Lab" component={LabScreen} options={{ title: 'My Bots' }} />
      <Tab.Screen name="Schools" component={SchoolScreen} options={{ title: 'Schools' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Tab.Navigator>
  );
}

function BotStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg.primary },
        headerTintColor: colors.text.primary,
      }}
    >
      <Stack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
      <Stack.Screen name="Bot" component={BotScreen} options={{ title: 'Bot' }} />
      <Stack.Screen name="Brain" component={BrainScreen} options={{ title: 'Brain' }} />
      <Stack.Screen name="Log" component={LogScreen} options={{ title: 'Activity Log' }} />
    </Stack.Navigator>
  );
}

export default function AppNavigator() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg.primary }}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {isAuthenticated ? <BotStack /> : <AuthStack />}
    </NavigationContainer>
  );
}
