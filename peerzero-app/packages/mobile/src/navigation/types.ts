// Navigation param list types for type-safe screen props
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabParamList = {
  Lab: undefined;
  Schools: undefined;
  Classes: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<TabParamList> | undefined;
  Bot: { botId: string };
  Brain: { botId: string };
  Log: { botId: string };
  CreateBot: undefined;
  EnrollBot: { botId: string };
  Stats: { botId: string };
  Platforms: { botId: string };
  ConnectPlatform: { botId: string };
  ClassDetail: { classId: string };
  Welcome: undefined;
};

export type BotScreenProps = NativeStackScreenProps<RootStackParamList, 'Bot'>;
export type CreateBotScreenProps = NativeStackScreenProps<RootStackParamList, 'CreateBot'>;
export type EnrollBotScreenProps = NativeStackScreenProps<RootStackParamList, 'EnrollBot'>;
