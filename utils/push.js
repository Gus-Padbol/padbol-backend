import { Expo } from 'expo-server-sdk';

const expo = new Expo();

export async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
    return;
  }

  const message = {
    to: pushToken,
    sound: 'default',
    title,
    body,
    data,
    color: '#e33030',
  };

  try {
    await expo.sendPushNotificationsAsync([message]);
  } catch (error) {
    console.error('Push notification error:', error);
  }
}

export async function resolveUserPushToken(supabaseAdmin, userId) {
  if (!userId) return null;

  const { data: perfil, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('push_token, expo_push_token')
    .eq('supabase_user_id', userId)
    .maybeSingle();

  if (error) {
    console.warn('⚠️ Push token lookup failed:', error.message);
    return null;
  }

  return perfil?.push_token ?? perfil?.expo_push_token ?? null;
}

export async function sendPushToUser(supabaseAdmin, userId, { title, body, data = {} }) {
  const pushToken = await resolveUserPushToken(supabaseAdmin, userId);
  if (!pushToken) {
    console.log('[push TODO]', userId, title);
    return;
  }

  await sendPushNotification(pushToken, title, body, data);
}
