export const PUSH_LANGUAGES = Object.freeze(['es','en','it','ro','cs','de','fr','pt-BR','pt-PT','ar','fa','nl-BE','nl-NL','hu','sv','af','el','he','pl','uk']);
export function normalizePushLanguage(value) {
  if (value == null || value === '') return 'es';
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/_/g, '-').toLowerCase();
  if (text === 'fa-ir') return 'fa';
  return PUSH_LANGUAGES.find((code) => code.toLowerCase() === text) || null;
}

const TRANSACTIONAL_COPY = Object.freeze({
  "es": "Tienes una actualización en Padbol Match. Abre la app para verla.",
  "en": "You have an update in Padbol Match. Open the app to view it.",
  "it": "Hai un aggiornamento su Padbol Match. Apri l'app per visualizzarlo.",
  "ro": "Ai o noutate în Padbol Match. Deschide aplicația pentru a o vedea.",
  "cs": "V aplikaci Padbol Match máte novinku. Otevřete aplikaci a zobrazte ji.",
  "de": "Es gibt Neuigkeiten in Padbol Match. Öffne die App, um sie anzusehen.",
  "fr": "Vous avez une nouveauté dans Padbol Match. Ouvrez l'application pour la consulter.",
  "pt-BR": "Você tem uma atualização no Padbol Match. Abra o aplicativo para conferir.",
  "pt-PT": "Tens uma atualização no Padbol Match. Abre a aplicação para a veres.",
  "ar": "لديك تحديث في Padbol Match. افتح التطبيق للاطلاع عليه.",
  "fa": "در Padbol Match به‌روزرسانی تازه‌ای دارید. برای دیدن آن برنامه را باز کنید.",
  "nl-BE": "Je hebt een update in Padbol Match. Open de app om deze te bekijken.",
  "nl-NL": "Je hebt een update in Padbol Match. Open de app om deze te bekijken.",
  "hu": "Újdonság vár a Padbol Match alkalmazásban. Nyisd meg az alkalmazást a megtekintéséhez.",
  "sv": "Du har en uppdatering i Padbol Match. Öppna appen för att se den.",
  "af": "Jy het 'n opdatering in Padbol Match. Maak die toepassing oop om dit te sien.",
  "el": "Έχετε μια ενημέρωση στο Padbol Match. Ανοίξτε την εφαρμογή για να τη δείτε.",
  "he": "יש לך עדכון ב-Padbol Match. יש לפתוח את האפליקציה כדי לצפות בו.",
  "pl": "Masz nową informację w Padbol Match. Otwórz aplikację, aby ją zobaczyć.",
  "uk": "У вас є оновлення в Padbol Match. Відкрийте застосунок, щоб його переглянути."
});
export function localizedPushPreview({ language, category, type, title, body }) {
  if (category !== "transactional" || type === "admin_message") return { title, body };
  const locale = normalizePushLanguage(language) || "es";
  return { title: "Padbol Match", body: TRANSACTIONAL_COPY[locale] };
}
