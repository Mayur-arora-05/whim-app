import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as AppleAuthentication from 'expo-apple-authentication';
import { supabase } from '@/lib/supabase';
import { isObjectionable } from '@/lib/moderation';
import { COLORS, SHADOWS, press } from '@/lib/theme';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

const TERMS_URL = 'https://pranjal250605.github.io/whim-app/terms.html';
const PRIVACY_URL = 'https://pranjal250605.github.io/whim-app/privacy.html';
const RESET_URL = 'https://pranjal250605.github.io/whim-app/reset.html';

const MARK = require('../assets/splash-icon.png');
const MARK_ASPECT = 678 / 518;

// Copy per mode. The LAYOUT never changes between modes — email, password/CTA
// and every tappable row keep identical positions so returning users can tap
// through on muscle memory. Only the third field slot swaps its content.
const COPY: Record<Mode, { headline: string; sub: string; cta: string }> = {
  'sign-in': { headline: 'Welcome back,\ntraveller.', sub: 'Pick up where you left off.', cta: 'Sign in' },
  'sign-up': { headline: 'Every trip\nstarts here.', sub: 'Make an account, start swiping.', cta: 'Create account' },
  forgot: { headline: 'Lost your\npassword?', sub: 'We’ll email you a link to set a new one.', cta: 'Email me a reset link' },
};

export default function SignIn() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  // Apple Sign-In ships once the Apple provider is configured in Supabase.
  const APPLE_ENABLED = false;
  useEffect(() => {
    if (APPLE_ENABLED && Platform.OS === 'ios') AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  const submit = async () => {
    const target = email.trim();
    if (!target) {
      Alert.alert('Missing email', 'Enter your email address.');
      return;
    }

    if (mode === 'forgot') {
      setBusy(true);
      const { error } = await supabase.auth.resetPasswordForEmail(target, { redirectTo: RESET_URL });
      setBusy(false);
      // never reveal whether an address has an account
      if (!error) {
        Alert.alert('Check your email', 'If that address has an account, a reset link is on its way.');
        setMode('sign-in');
      } else Alert.alert('Couldn’t send', error.message);
      return;
    }

    if (!password) {
      Alert.alert('Missing password', 'Enter your password.');
      return;
    }
    if (mode === 'sign-up' && password.length < 8) {
      Alert.alert('Weak password', 'Use at least 8 characters.');
      return;
    }
    if (mode === 'sign-up' && !name.trim()) {
      Alert.alert('What’s your name?', 'Friends will see it when you plan trips together.');
      return;
    }
    if (mode === 'sign-up' && isObjectionable(name)) {
      Alert.alert('Pick another name', 'That name contains language we don’t allow.');
      return;
    }

    setBusy(true);
    const { error } =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email: target, password })
        : await supabase.auth.signUp({
            email: target,
            password,
            // the signup trigger copies this into profiles.display_name
            options: { data: { display_name: name.trim().slice(0, 60) } },
          });
    setBusy(false);

    if (error) Alert.alert('Could not continue', error.message);
    else if (mode === 'sign-up') {
      Alert.alert('Almost there ✦', 'Check your email to confirm your account, then sign in.');
      setMode('sign-in');
    }
    // on success the auth listener flips the session and the guard routes home
  };

  const signInWithApple = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) throw new Error('No identity token from Apple.');
      const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken });
      if (error) Alert.alert('Apple sign-in failed', error.message);
    } catch (e: any) {
      if (e?.code !== 'ERR_REQUEST_CANCELED') Alert.alert('Apple sign-in failed', String(e?.message ?? e));
    }
  };

  const c = COPY[mode];

  return (
    <SafeAreaView className="flex-1 bg-canvas">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-1 justify-center px-7">
          {/* ── header: postmark + eyebrow + headline (fixed heights) ── */}
          <Image
            source={MARK}
            resizeMode="contain"
            style={{ width: 76, height: 76 / MARK_ASPECT, tintColor: COLORS.accent, transform: [{ rotate: '-4deg' }] }}
          />
          <View className="mt-5 flex-row items-center gap-2">
            <View className="h-1.5 w-1.5 rounded-full bg-accent" />
            <Text className="font-mono text-[11px] tracking-[0.18em] text-accent">PASSPORT CONTROL</Text>
          </View>
          <Text className="mt-2 font-serif text-[34px] leading-[1.04] text-ink" style={{ minHeight: 76 }}>
            {c.headline}
          </Text>
          <Text className="mt-1 text-[15px] text-muted" style={{ minHeight: 22 }}>
            {c.sub}
          </Text>

          {/* ── fields: three fixed 56pt slots — geometry never shifts ── */}
          <View className="mt-6" style={{ gap: 12 }}>
            {/* slot 1 — email, identical in every mode */}
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor="#B6B1A9"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              className="h-14 rounded-2xl border border-ink/10 bg-white px-4 text-[16px] text-ink"
            />
            {/* slot 2 — password, or the forgot-mode helper */}
            {mode === 'forgot' ? (
              <View className="h-14 justify-center rounded-2xl border border-dashed border-ink/15 px-4">
                <Text className="text-[13px] text-muted">The link opens a secure page to set a new password.</Text>
              </View>
            ) : (
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor="#B6B1A9"
                secureTextEntry
                autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                className="h-14 rounded-2xl border border-ink/10 bg-white px-4 text-[16px] text-ink"
              />
            )}
            {/* slot 3 — name (sign-up) / forgot link (sign-in) / spacer (forgot) */}
            {mode === 'sign-up' ? (
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Your name — friends will see it"
                placeholderTextColor="#B6B1A9"
                autoCapitalize="words"
                autoComplete="name"
                maxLength={60}
                className="h-14 rounded-2xl border border-ink/10 bg-white px-4 text-[16px] text-ink"
              />
            ) : mode === 'sign-in' ? (
              <View className="h-14 flex-row items-center justify-end px-1">
                <Pressable onPress={() => setMode('forgot')} hitSlop={10}>
                  <Text className="text-[13.5px] font-semibold text-accent">Forgot password?</Text>
                </Pressable>
              </View>
            ) : (
              <View className="h-14" />
            )}
          </View>

          {/* ── CTA: cobalt pill, same position in every mode ── */}
          <Pressable
            onPress={submit}
            disabled={busy}
            style={press(SHADOWS.accent)}
            className="mt-4 h-14 items-center justify-center rounded-full bg-accent"
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="text-[16px] font-bold text-white">{c.cta}</Text>
            )}
          </Pressable>

          {/* ── mode switch: fixed row ── */}
          <Pressable
            onPress={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
            hitSlop={8}
            className="mt-4 h-8 items-center justify-center"
          >
            <Text className="text-[14px] font-medium text-muted">
              {mode === 'sign-in' ? (
                <>New here?  <Text className="font-semibold text-ink">Create an account</Text></>
              ) : (
                <>Already have an account?  <Text className="font-semibold text-ink">Sign in</Text></>
              )}
            </Text>
          </Pressable>

          {/* ── legal consent (App Store: shown at account creation) ── */}
          <View className="mt-2 h-9 flex-row flex-wrap items-center justify-center">
            <Text className="text-[12px] text-muted">By continuing you agree to the </Text>
            <Pressable onPress={() => Linking.openURL(TERMS_URL)} hitSlop={6}>
              <Text className="text-[12px] font-semibold text-accent">Terms</Text>
            </Pressable>
            <Text className="text-[12px] text-muted"> and </Text>
            <Pressable onPress={() => Linking.openURL(PRIVACY_URL)} hitSlop={6}>
              <Text className="text-[12px] font-semibold text-accent">Privacy Policy</Text>
            </Pressable>
            <Text className="text-[12px] text-muted">.</Text>
          </View>

          {appleAvailable && (
            <View className="mt-6">
              <View className="mb-5 flex-row items-center gap-3">
                <View className="h-px flex-1 bg-ink/10" />
                <Text className="text-[12px] text-muted">or</Text>
                <View className="h-px flex-1 bg-ink/10" />
              </View>
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={28}
                style={{ height: 52, width: '100%' }}
                onPress={signInWithApple}
              />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
