const fs = require('fs');
const OpenAI = require('openai');
const axios = require('axios');
const busboy = require('busboy');
const cheerio = require('cheerio');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Scraper
async function scrape(htmlContent) {
  const $ = cheerio.load(htmlContent);
  const out = {
    name: $('h1[data-key="hospital_name"]').text().trim() || 'అమ్మ హాస్పిటల్',
    tagline: $('p[data-key="hospital_tagline"]').first().text().trim() || '',
    address: '',
    emergency_number: '',
    contact_numbers: [],
    email: $('span:contains("ammawomen.childcare@gmail.com")').text().trim() || '',
    services: [],
    doctors: [],
    working_hours: {},
    scrapedAt: new Date().toISOString()
  };

  const emergencyText = $('.emergency-info .emergency-number').text().trim();
  out.emergency_number = emergencyText.split(':')[1]?.trim() || '';

  $('.footer-section h4:contains("సంప్రదింపు వివరాలు")').next().find('span').each((i, el) => {
    const number = $(el).text().trim();
    if (number.length > 5) out.contact_numbers.push(number);
  });

  const aboutText = $('p[data-key="about_desc"]').text().trim();
  const addressMatch = aboutText.match(/అనంతపురము పట్టణంలోని (.+?)\./);
  out.address = addressMatch ? addressMatch[1] : 'అనంతపురం';

  $('.services-grid .service-card h3').each((i, el) => {
    const serviceName = $(el).text().trim();
    if (serviceName) out.services.push(serviceName);
  });

  const doctorMatch = aboutText.match(/డాక్టర్ టి\. శివజ్యోతి/);
  if (doctorMatch) {
    out.doctors.push({
      name: doctorMatch[0],
      specialty: 'ప్రసూతి మరియు గైనకాలజీ'
    });
  }

  out.working_hours['mon_sat'] = $('p:contains("సోమ - శని:")').text().split(':')[1]?.trim();
  out.working_hours['sunday'] = $('p:contains("ఆదివారం:")').text().split(':')[1]?.trim();

  return out;
}

// Transcribe
async function transcribeAudio(audioBuffer) {
  const tempPath = '/tmp/recording.webm';
  fs.writeFileSync(tempPath, audioBuffer);

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tempPath),
    model: "whisper-1",
    language: "te"
  });

  return transcription.text;
}

// Generate Reply
async function generateReply(userText, data) {
  const query = userText.toLowerCase().trim();
  const lang = /[\u0C00-\u0C7F]/.test(userText) ? 'te' : 'en';

  if (query.includes('address') || query.includes('అడ్రస్') || query.includes('location')) {
    return lang === 'te'
      ? `అమ్మ హాస్పిటల్ అనంతపురంలో ఆర్టీసీ బస్టాండ్ సమీపంలో ఉంది.`
      : `Amma Hospital is located in Anantapur, near the RTC Bus Stand.`;
  }
  if (query.includes('phone') || query.includes('ఫోన్') || query.includes('contact') || query.includes('నెంబర్')) {
    return lang === 'te'
      ? `మీరు మమ్మల్ని ${data.contact_numbers.join(' లేదా ')} నెంబర్లలో సంప్రదించవచ్చు.`
      : `You can contact us at ${data.contact_numbers.join(' or ')}.`;
  }
  if (query.includes('services') || query.includes('సేవలు')) {
    return lang === 'te'
      ? `మా ప్రధాన సేవలు: ${data.services.join(', ')} మరియు మరెన్నో.`
      : `Our main services are ${data.services.join(', ')}, and many more.`;
  }
  if (query.includes('doctor') || query.includes('డాక్టర్')) {
    const doc = data.doctors[0];
    return lang === 'te'
      ? `మా హాస్పిటల్ ప్రధాన డాక్టర్ ${doc.name}, ఆమె Obstetrics & Gynecology నిపుణురాలు.`
      : `Our main doctor is ${doc.name}, an expert in Obstetrics & Gynecology.`;
  }
  if (query.includes('hours') || query.includes('సమయాలు') || query.includes('టైమింగ్స్')) {
    return lang === 'te'
      ? `మా పని సమయాలు: సోమ-శని ${data.working_hours.mon_sat}, ఆదివారం ${data.working_hours.sunday}.`
      : `Our working hours: Mon-Sat ${data.working_hours.mon_sat}, Sun ${data.working_hours.sunday}.`;
  }

  // AI Reply
  const chatCompletion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{
      role: 'user',
      content: `You are a voice assistant for Amma Hospital in Anantapur. Use this data: ${JSON.stringify(data)}. User asked: "${userText}". Reply under 35 words in ${lang === 'te' ? 'Telugu' : 'English'}.`
    }],
    temperature: 0.5
  });

  return chatCompletion.choices[0].message.content.trim();
}

// Speech Synthesis
async function synthesizeSpeech(text) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Accept': 'audio/mpeg',
      },
      responseType: 'arraybuffer',
    }
  );

  return Buffer.from(response.data, 'binary').toString('base64');
}

// Handler
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const bb = busboy({ headers: event.headers });
  const audioBuffer = await new Promise((resolve, reject) => {
    const chunks = [];
    bb.on('file', (_, file) => {
      file.on('data', d => chunks.push(d));
      file.on('end', () => resolve(Buffer.concat(chunks)));
    });
    bb.on('error', reject);
    bb.end(Buffer.from(event.body, 'base64'));
  });

  try {
    const htmlResponse = await axios.get('https://ammahospital.com/');
    const hospitalData = await scrape(htmlResponse.data);

    const userText = await transcribeAudio(audioBuffer);
    const replyText = await generateReply(userText, hospitalData);
    const audioBase64 = await synthesizeSpeech(replyText);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: replyText, audio: audioBase64 }),
    };
  } catch (err) {
    console.error('Function error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error. Please try again.' }),
    };
  }
};
