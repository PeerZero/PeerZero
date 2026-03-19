// =============================================================================
// App navigator — tab-based navigation with auth gating
// Non-authenticated users see Login/Register. Authenticated users see the main tabs.
// =============================================================================

import React from 'react';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ActivityIndicator, View, Text, Platform } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';
import type { RootStackParamList, AuthStackParamList, TabParamList, WelcomeScreenWrapperProps } from '../navigation/types';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// Screens
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import WelcomeScreen from '../screens/WelcomeScreen';
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
import EggHatchScreen from '../screens/EggHatchScreen';
// Classes feature removed — DB tables retained for data safety

const Stack = createNativeStackNavigator<RootStackParamList>();
const AuthStackNav = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function AuthStack() {
  return (
    <AuthStackNav.Navigator screenOptions={{ headerShown: false }}>
      <AuthStackNav.Screen name="Login" component={LoginScreen} />
      <AuthStackNav.Screen name="Register" component={RegisterScreen} />
    </AuthStackNav.Navigator>
  );
}

// Simple text-based tab icon component (no icon library needed)
function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <View style={{
      width: 28, height: 28, borderRadius: 14,
      backgroundColor: focused ? colors.accent.primary + '20' : 'transparent',
      justifyContent: 'center', alignItems: 'center',
    }}>
      <Text style={{
        fontSize: 16,
        color: focused ? colors.accent.primary : colors.text.tertiary,
      }}>{label}</Text>
    </View>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg.primary, elevation: 0, shadowOpacity: 0 },
        headerTintColor: colors.text.primary,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: {
          backgroundColor: colors.bg.primary,
          borderTopColor: colors.border,
          paddingTop: 4,
          height: Platform.OS === 'ios' ? 88 : 64,
        },
        tabBarActiveTintColor: colors.accent.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Lab"
        component={LabScreen}
        options={{
          title: 'My Bots',
          tabBarIcon: ({ focused }) => <TabIcon label="🤖" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Schools"
        component={SchoolScreen}
        options={{
          title: 'Schools',
          tabBarIcon: ({ focused }) => <TabIcon label="🏫" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => <TabIcon label="⚙️" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

// Wrapper to provide navigation callback to WelcomeScreen
function WelcomeScreenWrapper({ navigation }: WelcomeScreenWrapperProps) {
  return <WelcomeScreen onComplete={() => navigation.replace('MainTabs')} />;
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
      <Stack.Screen name="Welcome" component={WelcomeScreenWrapper} options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="Bot" component={BotScreen} options={{ title: 'Bot' }} />
      <Stack.Screen name="Brain" component={BrainScreen} options={{ title: 'Brain' }} />
      <Stack.Screen name="Log" component={LogScreen} options={{ title: 'Activity Log' }} />
      <Stack.Screen name="CreateBot" component={CreateBotScreen} options={{ title: 'Create Bot' }} />
      <Stack.Screen name="EggHatch" component={EggHatchScreen} options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="EnrollBot" component={EnrollBotScreen} options={{ title: 'Enroll in School' }} />
      <Stack.Screen name="Stats" component={StatsScreen} options={{ title: 'Stats' }} />
      <Stack.Screen name="Platforms" component={PlatformsScreen} options={{ title: 'Platforms' }} />
      <Stack.Screen name="ConnectPlatform" component={ConnectPlatformScreen} options={{ title: 'Connect Platform' }} />
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
        <View style={{
          width: 80, height: 80, borderRadius: 40,
          backgroundColor: colors.accent.primary + '20',
          justifyContent: 'center', alignItems: 'center',
          marginBottom: 16,
        }}>
          <Text style={{ fontSize: 32, fontWeight: '900', color: colors.accent.primary, letterSpacing: -1 }}>P0</Text>
        </View>
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
