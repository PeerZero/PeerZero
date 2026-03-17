// =============================================================================
// App navigator — tab-based navigation with auth gating
// Non-authenticated users see Login/Register. Authenticated users see the main tabs.
// =============================================================================

import React from 'react';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';
import type { RootStackParamList } from '../navigation/types';

// Screens
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import LabScreen from '../screens/LabScreen';
import BotScreen from '../screens/BotScreen';
import BrainScreen from '../screens/BrainScreen';
import LogScreen from '../screens/LogScreen';
import SchoolScreen from '../screens/SchoolScreen';
import SettingsScreen from '../screens/SettingsScreen';
import CreateBotScreen from '../screens/CreateBotScreen';
import EnrollBotScreen from '../screens/EnrollBotScreen';
import StatsScreen from '../screens/StatsScreen';
import PlatformsScreen from '../screens/PlatformsScreen';
import ConnectPlatformScreen from '../screens/ConnectPlatformScreen';
import ClassesScreen from '../screens/ClassesScreen';
import ClassDetailScreen from '../screens/ClassDetailScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const AuthStackNav = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function AuthStack() {
  return (
    <AuthStackNav.Navigator screenOptions={{ headerShown: false }}>
      <AuthStackNav.Screen name="Login" component={LoginScreen} />
      <AuthStackNav.Screen name="Register" component={RegisterScreen} />
    </AuthStackNav.Navigator>
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
      <Tab.Screen name="Classes" component={ClassesScreen} options={{ title: 'Classes' }} />
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
      <Stack.Screen name="CreateBot" component={CreateBotScreen} options={{ title: 'Create Bot' }} />
      <Stack.Screen name="EnrollBot" component={EnrollBotScreen} options={{ title: 'Enroll in School' }} />
      <Stack.Screen name="Stats" component={StatsScreen} options={{ title: 'Stats' }} />
      <Stack.Screen name="Platforms" component={PlatformsScreen} options={{ title: 'Platforms' }} />
      <Stack.Screen name="ConnectPlatform" component={ConnectPlatformScreen} options={{ title: 'Connect Platform' }} />
      <Stack.Screen name="ClassDetail" component={ClassDetailScreen} options={{ title: 'Class' }} />
    </Stack.Navigator>
  );
}

// Deep linking configuration — widgets and overlay tap → navigate to bot screen
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['peerzero://'],
  config: {
    screens: {
      // Widget taps deep-link directly to bot detail
      Bot: {
        path: 'bot/:botId',
      },
      // Widget setup link → settings tab
      MainTabs: {
        screens: {
          Settings: 'settings/widgets',
        },
      },
    },
  },
};

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
    <NavigationContainer linking={isAuthenticated ? linking : undefined}>
      {isAuthenticated ? <BotStack /> : <AuthStack />}
    </NavigationContainer>
  );
}
