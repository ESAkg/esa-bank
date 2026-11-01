'use strict';
/* ESA Bank — i18n: кыргызча / орусча / англисче, өзгөрмөлүү (localStorage) */

const DICT = {
  ky: {
    app_name: 'ESA Bank', app_tagline: 'Сенин ишенимдүү банкың',
    search_placeholder: 'Издөө... (мисалы: которуу, эсеп, карта)',
    nav_home: 'Башкы бет', nav_accounts: 'Эсептер', nav_cards: 'Карталар',
    nav_transfers: 'Которуулар', nav_qr: 'QR төлөмдөр', nav_deposits: 'Депозиттер',
    nav_credits: 'Кредиттер', nav_stats: 'Көрсөткүчтөр', nav_history: 'Тарых',
    nav_profile: 'Жеке маалымат', nav_help: 'Жардам', nav_logout: 'Чыгуу',
    greeting_hi: 'Салам',
    main_account: 'Негизги эсеп', card_label: 'Карта', deposit_label: 'Жыйынды депозит',
    available_funds: 'Колдонмо каражат', main_card: 'Негизги карта (Visa)',
    qa_transfer: 'Которуу', qa_qr: 'QR менен төлөм', qa_phone: 'Телефон менен которуу',
    qa_card2card: 'Картадан картага', qa_deposit: 'Депозит ачуу', qa_credit: 'Кредит алуу',
    recent_ops: 'Жакында болгон операциялар', see_all: 'Баары',
    funds_dynamics: 'Каражаттардын кыймылы', expenses_by_cat: 'Чыгашалар боюнча',
    income: 'Кирешe', expense: 'Чыгаша', total: 'жалпы',
    currency_rates: 'Валюта курстары', buy: 'Сатып алуу', sell: 'Сатуу',
    rates_live: 'Реалдуу убакыт', rates_cached: 'Акыркы белгилүү маалымат',
    qr_pay_panel: 'QR менен төлө', qr_pay_desc: 'QR кодду сканерлеп, төлөмдү тандаңыз',
    qr_open: 'QR ачуу',
    promo_title: 'Жаңы мүмкүнчүлүктөр!', promo_desc: 'Биздин мобилдик тиркемени жүктөп алыңыз',
    news_title: 'Акыркы жаңылыктар',
    support_title: 'Колдоо кызматы', support_desc: 'Биз ар дайым жардам берүүгө даярбыз!', support_call: 'Чалуу',
    no_ops: 'Операциялар жок',
    empty_state_loading: 'Жүктөлүүдө...',
    btn_login: 'Кирүү', btn_register: 'Катталуу', btn_logout: 'Чыгуу',
    forgot_password: 'Сырсөздү унуттуңузбу?', new_account: 'Жаңы аккаунт түзүү',
    back: 'Артка',
    screen_cards: 'Карталар', screen_deposits: 'Депозиттер', screen_credits: 'Кредиттер',
    screen_stats: 'Көрсөткүчтөр', screen_help: 'Жардам', screen_profile: 'Профиль',
    screen_history: 'Операциялардын тарыхы',
    stats_monthly_spend: 'Бул айда чыгымдар', stats_no_data: 'Бул айда маалымат жок',
    cat_food: 'Тамак-аш', cat_transport: 'Транспорт', cat_bills: 'Төлөмдөр',
    cat_entertainment: 'Көңүл ачуу', cat_shopping: 'Соода', cat_health: 'Ден соолук', cat_other: 'Башка',
    deposits_intro: 'Жогорку пайыздык чен менен каражатыңызды сактаңыз',
    deposit_classic: 'Классикалык', deposit_online: 'Онлайн', deposit_child: 'Эндик',
    open_deposit: 'Депозит ачуу', coming_soon: 'Жакында',
    credits_intro: 'Максатыңызга жетүү үчүн кредит алыңыз',
    credit_consumer: 'Керектөө кредити', credit_auto: 'Авто кредит', credit_mortgage: 'Ипотека',
    get_credit: 'Кредит алуу',
    help_intro: 'Бизге кайрылыңыз — 24/7 жардам берүүгө даярбыз',
    help_phone: 'Телефон', help_email: 'Электрондук почта', help_chat: 'Онлайн чат',
    theme_light: 'Жарык тема', theme_dark: 'Караңгы тема',
    install_app: 'Тиркеме катары орнотуу',
    qr_scan_any: 'Каалаган QR кодду скандоо (башка банктар менен шайкеш)',
    qr_unknown_format: 'Бул QR коддун форматы таанылган жок. ESA Bank тармагындагы колдонуучулардын кодун же маалыматты кол менен киргизиңиз.',
    category_label: 'Категория',
    client_no: 'Клиент №',
  },
  ru: {
    app_name: 'ESA Bank', app_tagline: 'Твой надёжный банк',
    search_placeholder: 'Поиск... (например: перевод, счёт, карта)',
    nav_home: 'Главная', nav_accounts: 'Счета', nav_cards: 'Карты',
    nav_transfers: 'Переводы', nav_qr: 'QR-платежи', nav_deposits: 'Депозиты',
    nav_credits: 'Кредиты', nav_stats: 'Статистика', nav_history: 'История',
    nav_profile: 'Личные данные', nav_help: 'Помощь', nav_logout: 'Выйти',
    greeting_hi: 'Привет',
    main_account: 'Основной счёт', card_label: 'Карта', deposit_label: 'Общий депозит',
    available_funds: 'Доступные средства', main_card: 'Основная карта (Visa)',
    qa_transfer: 'Перевод', qa_qr: 'Оплата по QR', qa_phone: 'Перевод по телефону',
    qa_card2card: 'Карта в карту', qa_deposit: 'Открыть депозит', qa_credit: 'Взять кредит',
    recent_ops: 'Последние операции', see_all: 'Все',
    funds_dynamics: 'Движение средств', expenses_by_cat: 'Расходы по категориям',
    income: 'Доход', expense: 'Расход', total: 'всего',
    currency_rates: 'Курсы валют', buy: 'Покупка', sell: 'Продажа',
    rates_live: 'В реальном времени', rates_cached: 'Последние известные данные',
    qr_pay_panel: 'Оплатить по QR', qr_pay_desc: 'Отсканируйте QR-код и выберите платёж',
    qr_open: 'Открыть QR',
    promo_title: 'Новые возможности!', promo_desc: 'Скачайте наше мобильное приложение',
    news_title: 'Последние новости',
    support_title: 'Служба поддержки', support_desc: 'Мы всегда готовы помочь!', support_call: 'Позвонить',
    no_ops: 'Операций нет',
    empty_state_loading: 'Загрузка...',
    btn_login: 'Войти', btn_register: 'Регистрация', btn_logout: 'Выйти',
    forgot_password: 'Забыли пароль?', new_account: 'Создать новый аккаунт',
    back: 'Назад',
    screen_cards: 'Карты', screen_deposits: 'Депозиты', screen_credits: 'Кредиты',
    screen_stats: 'Статистика', screen_help: 'Помощь', screen_profile: 'Профиль',
    screen_history: 'История операций',
    stats_monthly_spend: 'Расходы в этом месяце', stats_no_data: 'За этот месяц данных нет',
    cat_food: 'Еда', cat_transport: 'Транспорт', cat_bills: 'Платежи',
    cat_entertainment: 'Развлечения', cat_shopping: 'Покупки', cat_health: 'Здоровье', cat_other: 'Прочее',
    deposits_intro: 'Храните средства под высокий процент',
    deposit_classic: 'Классический', deposit_online: 'Онлайн', deposit_child: 'Накопительный',
    open_deposit: 'Открыть депозит', coming_soon: 'Скоро',
    credits_intro: 'Получите кредит для своих целей',
    credit_consumer: 'Потребительский кредит', credit_auto: 'Автокредит', credit_mortgage: 'Ипотека',
    get_credit: 'Взять кредит',
    help_intro: 'Свяжитесь с нами — работаем 24/7',
    help_phone: 'Телефон', help_email: 'Эл. почта', help_chat: 'Онлайн-чат',
    theme_light: 'Светлая тема', theme_dark: 'Тёмная тема',
    install_app: 'Установить как приложение',
    qr_scan_any: 'Сканировать любой QR-код (совместимо с другими банками)',
    qr_unknown_format: 'Формат этого QR-кода не распознан. Введите код пользователя ESA Bank или данные вручную.',
    category_label: 'Категория',
    client_no: 'Клиент №',
  },
  en: {
    app_name: 'ESA Bank', app_tagline: 'Your trusted bank',
    search_placeholder: 'Search... (e.g. transfer, account, card)',
    nav_home: 'Home', nav_accounts: 'Accounts', nav_cards: 'Cards',
    nav_transfers: 'Transfers', nav_qr: 'QR payments', nav_deposits: 'Deposits',
    nav_credits: 'Loans', nav_stats: 'Statistics', nav_history: 'History',
    nav_profile: 'Profile', nav_help: 'Help', nav_logout: 'Log out',
    greeting_hi: 'Hello',
    main_account: 'Main account', card_label: 'Card', deposit_label: 'Total deposits',
    available_funds: 'Available funds', main_card: 'Main card (Visa)',
    qa_transfer: 'Transfer', qa_qr: 'Pay by QR', qa_phone: 'Transfer by phone',
    qa_card2card: 'Card to card', qa_deposit: 'Open deposit', qa_credit: 'Get a loan',
    recent_ops: 'Recent transactions', see_all: 'See all',
    funds_dynamics: 'Funds dynamics', expenses_by_cat: 'Spending by category',
    income: 'Income', expense: 'Expense', total: 'total',
    currency_rates: 'Exchange rates', buy: 'Buy', sell: 'Sell',
    rates_live: 'Live', rates_cached: 'Last known data',
    qr_pay_panel: 'Pay by QR', qr_pay_desc: 'Scan a QR code and choose a payment',
    qr_open: 'Open QR',
    promo_title: 'New features!', promo_desc: 'Download our mobile app',
    news_title: 'Latest news',
    support_title: 'Support', support_desc: "We're always ready to help!", support_call: 'Call',
    no_ops: 'No transactions',
    empty_state_loading: 'Loading...',
    btn_login: 'Log in', btn_register: 'Sign up', btn_logout: 'Log out',
    forgot_password: 'Forgot password?', new_account: 'Create new account',
    back: 'Back',
    screen_cards: 'Cards', screen_deposits: 'Deposits', screen_credits: 'Loans',
    screen_stats: 'Statistics', screen_help: 'Help', screen_profile: 'Profile',
    screen_history: 'Transaction history',
    stats_monthly_spend: 'Spending this month', stats_no_data: 'No data for this month',
    cat_food: 'Food', cat_transport: 'Transport', cat_bills: 'Bills',
    cat_entertainment: 'Entertainment', cat_shopping: 'Shopping', cat_health: 'Health', cat_other: 'Other',
    deposits_intro: 'Keep your funds at a high interest rate',
    deposit_classic: 'Classic', deposit_online: 'Online', deposit_child: 'Savings',
    open_deposit: 'Open deposit', coming_soon: 'Coming soon',
    credits_intro: 'Get a loan for your goals',
    credit_consumer: 'Personal loan', credit_auto: 'Auto loan', credit_mortgage: 'Mortgage',
    get_credit: 'Get a loan',
    help_intro: "Contact us — we're available 24/7",
    help_phone: 'Phone', help_email: 'Email', help_chat: 'Live chat',
    theme_light: 'Light theme', theme_dark: 'Dark theme',
    install_app: 'Install as app',
    qr_scan_any: 'Scan any QR code (compatible with other banks)',
    qr_unknown_format: "This QR code format wasn't recognized. Enter an ESA Bank user code or details manually.",
    category_label: 'Category',
    client_no: 'Client No.',
  }
};

const CATEGORY_KEYS = { food: 'cat_food', transport: 'cat_transport', bills: 'cat_bills', entertainment: 'cat_entertainment', shopping: 'cat_shopping', health: 'cat_health', other: 'cat_other' };

let currentLang = localStorage.getItem('esa_lang') || 'ky';
if (!DICT[currentLang]) currentLang = 'ky';

function t(key) {
  return (DICT[currentLang] && DICT[currentLang][key]) || (DICT.ky[key]) || key;
}

function setLang(lang) {
  if (!DICT[lang]) return;
  currentLang = lang;
  localStorage.setItem('esa_lang', lang);
  document.documentElement.lang = lang;
  applyTranslations();
  document.dispatchEvent(new CustomEvent('langchange'));
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-lang-btn]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.langBtn === currentLang);
  });
}
