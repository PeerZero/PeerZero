// Navigation param list types for type-safe screen props
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';

export type AuthStackParamList = {
  Login: { message?: string } | undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

export type TabParamList = {
  Lab: undefined;
  Schools: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<TabParamList> | undefined;
  Bot: { botId: string };
  Brain: { botId: string };
  Log: { botId: string };
  Chat: { botId: string };
  CreateBot: undefined;
  EggHatch: { botId: string; botName: string; bodyColor: string; speciesSeed?: string };
  EnrollBot: { botId: string };
  Stats: { botId: string };
  Platforms: { botId: string };
  ConnectPlatform: { botId: string };
  Welcome: undefined;
};

// Auth stack screens
export type LoginScreenProps = NativeStackScreenProps<AuthStackParamList, 'Login'>;
export type RegisterScreenProps = NativeStackScreenProps<AuthStackParamList, 'Register'>;
export type ForgotPasswordScreenProps = NativeStackScreenProps<AuthStackParamList, 'ForgotPassword'>;

// Root stack screens
export type BotScreenProps = NativeStackScreenProps<RootStackParamList, 'Bot'>;
export type CreateBotScreenProps = NativeStackScreenProps<RootStackParamList, 'CreateBot'>;
export type EnrollBotScreenProps = NativeStackScreenProps<RootStackParamList, 'EnrollBot'>;
export type BrainScreenProps = NativeStackScreenProps<RootStackParamList, 'Brain'>;
export type LogScreenProps = NativeStackScreenProps<RootStackParamList, 'Log'>;
export type StatsScreenProps = NativeStackScreenProps<RootStackParamList, 'Stats'>;
export type ChatScreenProps = NativeStackScreenProps<RootStackParamList, 'Chat'>;
export type PlatformsScreenProps = NativeStackScreenProps<RootStackParamList, 'Platforms'>;
export type ConnectPlatformScreenProps = NativeStackScreenProps<RootStackParamList, 'ConnectPlatform'>;
export type EggHatchScreenProps = NativeStackScreenProps<RootStackParamList, 'EggHatch'>;
export type WelcomeScreenWrapperProps = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

// Tab screens (composite: tab nested inside root stack)
export type LabScreenProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'Lab'>,
  NativeStackScreenProps<RootStackParamList>
>;
