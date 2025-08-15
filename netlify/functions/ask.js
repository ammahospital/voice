// netlify/functions/ask.js
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const axios = require('axios');
const busboy = require('busboy');
const cheerio = require('cheerio');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// A simplified scraper function that can be called directly
async function scrape(htmlContent) {
  console.log('Starting scrape...');
  const $ = cheerio.load(htmlContent);

  const out = {
    name: 'అమ్మ హాస్పిటల్',
    tagline: '',
    address: '',
    emergency_number: '',
    contact_numbers: [],
    email: '',
    services: [],
    doctors: [],
    working_hours: {},
    scrapedAt: new Date().toISOString()
  };

  out.name = $('h1[data-key="hospital_name"]').text().trim() || 'అమ్మ హాస్పిటల్';
  out.tagline = $('p[data-key="hospital_tagline"]').first().text().trim() || '';
  const emergencyText = $('.emergency-info .emergency-number').text().trim();
  out.emergency_number = emergencyText.split(':')[1]?.trim() || '';

  $('.footer-section h4:contains("సంప్రదింపు వివరాలు")').next().find('span').each((i, el) => {
    const number = $(el).text().trim();
    if (number.length > 5) out.contact_numbers.push(number);
  });
  out.email = $('span:contains("ammawomen.childcare@gmail.com")').text().trim() || 'Not available';

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

// Function to transcribe audio
async function transcribeAudio(audioBuffer) {
  try {
    // Save buffer to temporary file in Netlify function
    const tempPath = '/tmp/recording.webm';
    fs.writeFileSync(tempPath, audioBuffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      language: "te"
    });

    console.log('Transcription:', transcription.text);
    return transcription.text;
  } catch (error) {
    console.error('Error during transcription:', error);
    throw new Error('Transcription failed.');
  }
}

// Function to generate a reply
async function generateReply(userText, data) {
  const query = userText.toLowerCase().trim();
  const langMatch = userText.match(/[\u0C00-\u0C7F]/);
  const lang = langMatch ? 'te' : 'en';

  if (query.includes('అడ్రస్') || query.includes('address') || query.includes('location')) {
    return lang === 'te'
      ? `అమ్మ హాస్పిటల్ అనంతపురంలో ఆర్టీసీ బస్టాండ్ సమీపంలో ఉంది.`
      : `Amma Hospital is located in Anantapur, near the RTC Bus Stand.`;
  }
  if (query.includes('ఫోన్') || query.includes('contact') || query.includes('phone') || query.includes('నెంబర్')) {
    return lang === 'te'
      ? `మీరు మమ్మల్ని ${data.contact_numbers.join(' లేదా ')} నెంబర్లలో సంప్రదించవచ్చు.`
      : `You can contact us at ${data.contact_numbers.join(' or ')}.`;
  }
  if (query.includes('సేవలు') || query.includes('services')) {
    const servicesList = data.services.join(', ');
    return lang === 'te'
      ? `మా ప్రధాన సేవలు: ${servicesList} మరియు మరెన్నో.`
      : `Our main services are ${servicesList}, and many more.`;
  }
  if (query.includes('డాక్టర్') || query.includes('doctor')) {
    const doctor = data.doctors[0];
    return lang === 'te'
      ? `మా హాస్పిటల్ ప్రధాన డాక్టర్ డాక్టర్ టి. శివజ్యోతి గారు, ఆమె Obstetrics & Gynecology నిపుణురాలు.`
      : `Our main doctor is Dr. T. Sivajyothi, an expert in Obstetrics & Gynecology.`;
  }
  if (query.includes('టైమింగ్స్') || query.includes('hours') || query.includes('సమయాలు')) {
    const hours = data.working_hours;
    return lang === 'te'
      ? `మా పని సమయాలు: సోమవారం నుండి శనివారం వరకు ${hours.mon_sat} మరియు ఆదివారం ${hours.sunday}.`
      : `Our working hours are from Monday to Saturday: ${hours.mon_sat}, and on Sunday: ${hours.sunday}.`;
  }

  try {
    const prompt = `You are a friendly voice assistant for Amma Hospital in Anantapur. Use the following data for facts:
    <JSON data>
    ${JSON.stringify(data)}
    </JSON data>
    User asked: "${userText}"
    Give a short, clear spoken reply (Telugu or English based on query). If you cannot find a fact, say in Telugu or English: "I will connect you to our representative." Keep length under 35 words.`;

    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
    });

    const reply = chatCompletion.choices[0].message.content.trim();
    console.log('LLM Reply:', reply);
    return reply;

  } catch (error) {
    console.error('Error calling OpenAI LLM:', error);
    return lang === 'te'
      ? 'క్షమించండి, నేను మీ అభ్యర్థనను ప్రస్తుతం ప్రాసెస్ చేయలేకపోతున్నాను. దయచేసి హాస్పిటల్‌కి నేరుగా కాల్ చేయండి.'
      : 'I apologize, I am unable to process your request at the moment. Please call the hospital directly.';
  }
}

// Function to synthesize speech
async function synthesizeSpeech(text) {
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
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

    const audioBase64 = Buffer.from(response.data, 'binary').toString('base64');
    return audioBase64;
  } catch (error) {
    console.error('Error during speech synthesis:', error.response?.data?.toString() || error.message);
    throw new Error('Speech synthesis failed.');
  }
}

// The main handler for the Netlify Function
exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const bb = busboy({ headers: event.headers });
  let audioBuffer;

  const getAudioBuffer = new Promise((resolve, reject) => {
    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', data => chunks.push(data));
      file.on('end', () => resolve(Buffer.concat(chunks)));
    });
    bb.on('error', err => reject(err));
    bb.end(Buffer.from(event.body, 'base64'));
  });

  try {
    audioBuffer = await getAudioBuffer;
    if (!audioBuffer) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No audio file uploaded.' }) };
    }

    const htmlResponse = await axios.get('https://ammahospital.com/');
    const hospitalData = await scrape(htmlResponse.data);

    const userText = await transcribeAudio(audioBuffer);
    const replyText = await generateReply(userText, hospitalData);
    const audioBase64 = await synthesizeSpeech(replyText);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: replyText,
        audio: audioBase64
      }),
    };
  } catch (err) {
    console.error('Error in Netlify function:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error. Please try again.' }),
    };
  }
};
