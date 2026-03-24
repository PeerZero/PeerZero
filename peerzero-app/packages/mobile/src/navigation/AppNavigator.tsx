// =============================================================================
// App navigator — redesigned tab bar with floating style + auth gating
// =============================================================================

import React from 'react';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ActivityIndicator, View, Text, Platform } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';
import { borderRadius } from '../theme/spacing';
import type { RootStackParamList, AuthStackParamList, TabParamList, WelcomeScreenWrapperProps } from '../navigation/types';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// Screens — Auth
import LoginScreen from '../screens/auth/LoginScreen';
import RegisterScreen from '../screens/auth/RegisterScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';
import WelcomeScreen from '../screens/auth/WelcomeScreen';

// Screens — Bot
import BotScreen from '../screens/bot/BotScreen';

// Screens — Bot features
import BrainScreen from '../screens/bot-features/BrainScreen';
import ChatScreen from '../screens/bot-features/ChatScreen';
import LogScreen from '../screens/bot-features/LogScreen';
import StatsScreen from '../screens/bot-features/StatsScreen';

// Screens — Bot lifecycle
import CreateBotScreen from '../screens/bot-lifecycle/CreateBotScreen';
import EggHatchScreen from '../screens/bot-lifecycle/EggHatchScreen';
import EnrollBotScreen from '../screens/bot-lifecycle/EnrollBotScreen';

// Screens — School
import SchoolScreen from '../screens/school/SchoolScreen';
import PlatformsScreen from '../screens/school/PlatformsScreen';
import ConnectPlatformScreen from '../screens/school/ConnectPlatformScreen';

// Screens — Settings
import SettingsScreen from '../screens/settings/SettingsScreen';

// Screens — Lab
import LabScreen from '../screens/lab/LabScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const AuthStackNav = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function AuthStack() {
  return (
    <AuthStackNav.Navigator screenOptions={{ headerShown: false }}>
      <AuthStackNav.Screen name="Login" component={LoginScreen} />
      <AuthStackNav.Screen name="Register" component={RegisterScreen} />
      <AuthStackNav.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
    </AuthStackNav.Navigator>
  );
}

// Modern tab icon with indicator dot
function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <View style={{
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 2,
    }}>
      <Text style={{
        fontSize: 20,
        opacity: focused ? 1 : 0.5,
      }}>{label}</Text>
      {focused && (
        <View style={{
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.accent.primary,
          marginTop: 4,
        }} />
      )}
    </View>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.bg.primary,
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 0,
        },
        headerTintColor: colors.text.primary,
        headerTitleStyle: { fontWeight: '700', fontSize: 18, letterSpacing: -0.3 },
        tabBarStyle: {
          backgroundColor: colors.bg.secondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 28 : 12,
          height: Platform.OS === 'ios' ? 88 : 68,
          // Subtle top shadow
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          elevation: 8,
        },
        tabBarActiveTintColor: colors.accent.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.2,
          marginTop: -2,
        },
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
        headerStyle: {
          backgroundColor: colors.bg.primary,
        },
        headerTintColor: colors.text.primary,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        animation: 'slide_from_right',
        animationDuration: 250,
      }}
    >
      <Stack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
      <Stack.Screen name="Welcome" component={WelcomeScreenWrapper} options={{ headerShown: false, presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="Bot" component={BotScreen} options={{ title: 'Bot' }} />
      <Stack.Screen name="Brain" component={BrainScreen} options={{ title: 'Brain' }} />
      <Stack.Screen name="Log" component={LogScreen} options={{ title: 'Activity Log' }} />
      <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'Chat' }} />
      <Stack.Screen name="CreateBot" component={CreateBotScreen} options={{ title: 'Create Bot', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="EggHatch" component={EggHatchScreen} options={{ headerShown: false, gestureEnabled: false, animation: 'slide_from_bottom' }} />
      <Stack.Screen name="EnrollBot" component={EnrollBotScreen} options={{ title: 'Enroll in School', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="Stats" component={StatsScreen} options={{ title: 'Stats' }} />
      <Stack.Screen name="Platforms" component={PlatformsScreen} options={{ title: 'Platforms' }} />
      <Stack.Screen name="ConnectPlatform" component={ConnectPlatformScreen} options={{ title: 'Connect Platform', animation: 'slide_from_bottom' }} />
    </Stack.Navigator>
  );
}

// Deep linking configuration — widgets and overlay tap → navigate to bot screen
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['peerzero://'],
  config: {
    screens: {
      Bot: {
        path: 'bot/:botId',
      },
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
      <View style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.bg.primary,
      }}>
        <View style={{
          width: 80,
          height: 80,
          borderRadius: borderRadius.xl,
          backgroundColor: colors.accent.primary + '15',
          justifyContent: 'center',
          alignItems: 'center',
          marginBottom: 20,
          // Subtle glow
          shadowColor: colors.accent.primary,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.3,
          shadowRadius: 20,
        }}>
          <Text style={{
            fontSize: 32,
            fontWeight: '900',
            color: colors.accent.primary,
            letterSpacing: -1,
          }}>P0</Text>
        </View>
        <ActivityIndicator size="large" color={colors.accent.primary} />
        <Text style={{
          color: colors.text.tertiary,
          fontSize: 12,
          marginTop: 16,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}>Loading</Text>
      </View>
    );
  }

  return (
    <NavigationContainer linking={isAuthenticated ? linking : undefined}>
      {isAuthenticated ? <BotStack /> : <AuthStack />}
    </NavigationContainer>
  );
}
