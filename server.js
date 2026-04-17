// ============================================================
//  MediScan AI — server.js
//  Node.js + Express backend
//  Install dependencies:
//    npm install express cors multer pdfkit anthropic dotenv
//  Set your API key:
//    Create a .env file: ANTHROPIC_API_KEY=your_key_here
//  Run:
//    node server.js
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname)));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });async function askGroq(userPrompt, systemPrompt = "") {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 2000,
    messages: [
      { role: "system", content: systemPrompt || "You are a helpful medical information assistant." },
      { role: "user", content: userPrompt }
    ],
  });
  return response.choices[0].message.content;
}

async function askGroqMessages(messages, systemPrompt = "") {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 2000,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages
    ],
  });
  return response.choices[0].message.content;
}

function safeJSON(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 1. Medicine Search
app.post("/api/medicine/search", async (req, res) => {
  const { name, language = "en" } = req.body;
  if (!name) return res.status(400).json({ error: "Medicine name required" });

  const langMap = { te: "Telugu", hi: "Hindi", ta: "Tamil", fr: "French", es: "Spanish", ar: "Arabic", en: "English" };
  const langNote = language !== "en" ? `Respond entirely in ${langMap[language] || "English"}.` : "";

  try {
    const raw = await askGroq(
      `Provide comprehensive medical information about the medicine/injection "${name}".
Return ONLY a valid JSON object — no markdown, no backticks, no explanation — with these exact keys:
{
  "name": "full generic name",
  "brandNames": ["brand1","brand2"],
  "type": "Tablet|Injection|Syrup|Capsule|Cream|Drops",
  "category": "pharmacological category",
  "mechanism": "brief mechanism of action",
  "advantages": ["benefit1","benefit2","benefit3","benefit4"],
  "disadvantages": ["downside1","downside2","downside3"],
  "sideEffects": {
    "common": ["effect1","effect2","effect3"],
    "serious": ["effect1","effect2"],
    "rare": ["effect1","effect2"]
  },
  "doses": [
    {"ageGroup":"Children (2-12 yrs)","dose":"X mg/kg","frequency":"every X hrs","notes":"with food"},
    {"ageGroup":"Adults (18-60 yrs)","dose":"X mg","frequency":"every X hrs","notes":""},
    {"ageGroup":"Elderly (60+ yrs)","dose":"X mg","frequency":"every X hrs","notes":"reduce dose"},
    {"ageGroup":"Infants (<2 yrs)","dose":"consult doctor","frequency":"—","notes":""}
  ],
  "contraindications": ["condition1","condition2"],
  "interactions": ["drug1","drug2","drug3"],
  "storage": "storage instructions",
  "pregnancy": "safe|caution|avoid|unknown",
  "overdose": "overdose symptoms and first aid"
}
${langNote}`,
      "You are a medical database. Return ONLY valid JSON. No markdown. No explanation."
    );

    const data = safeJSON(raw);
    if (!data) return res.status(500).json({ error: "Failed to parse AI response", raw });
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2. AI Chatbot
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: "Messages required" });

  try {
    const reply = await askGroqMessages(
      messages,
      `You are MediScan AI, a helpful health assistant. Provide clear, accurate, evidence-based medical information.
Always recommend consulting a licensed doctor for diagnosis or treatment.
Be concise, friendly, and use simple language.`
    );
    res.json({ success: true, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Process Typed Prescription
app.post("/api/prescription/process", async (req, res) => {
  const { patient, age, doctor, date, medicines } = req.body;
  if (!medicines) return res.status(400).json({ error: "Medicines text required" });

  try {
    const raw = await askGroq(
      `Parse this prescription text into structured JSON.
Medicines text: "${medicines}"
Return ONLY a JSON array — no markdown — where each item has:
{ "name":"","strength":"","form":"tablet/injection/syrup","frequency":"","duration":"","timing":"before/after meals","instructions":"","sideEffectNote":"","warnings":"" }`,
      "Return ONLY valid JSON array. No markdown. No explanation."
    );

    const items = safeJSON(raw) || [];
    res.json({ success: true, patient, age, doctor, date, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Scan Prescription Image (using Groq vision)
app.post("/api/prescription/scan", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const base64 = req.file.buffer.toString("base64");
  const mediaType = req.file.mimetype || "image/jpeg";

  try {
    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${base64}` }
            },
            {
              type: "text",
              text: `Extract all information from this prescription image and return ONLY a JSON object — no markdown — with:
{
  "doctor": "name + qualification",
  "clinic": "clinic/hospital name",
  "date": "date if visible",
  "patient": "patient name if visible",
  "age": "age if visible",
  "medicines": [
    {"name":"","strength":"","frequency":"","duration":"","instructions":""}
  ],
  "diagnosis": "diagnosis if mentioned",
  "notes": "any additional notes",
  "confidence": "high|medium|low"
}`
            }
          ]
        }
      ],
    });

    const raw = response.choices[0].message.content;
    const data = safeJSON(raw);
    if (!data) return res.status(500).json({ error: "Could not parse prescription", raw });
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 5. Symptom Advisor
app.post("/api/symptom/advice", async (req, res) => {
  const { situation } = req.body;
  if (!situation) return res.status(400).json({ error: "Situation description required" });

  try {
    const raw = await askGroq(
      `Patient situation: "${situation}"
Analyze and return ONLY a JSON object — no markdown:
{
  "severity": "low|medium|high|emergency",
  "immediateAction": "what to do right now",
  "possibleCauses": ["cause1","cause2","cause3"],
  "suggestedMedicines": [
    {"name":"OTC medicine","purpose":"why","dose":"how much","note":"important note"}
  ],
  "homeRemedies": ["remedy1","remedy2"],
  "whenToSeeDoctor": "specific triggers",
  "doNots": ["avoid1","avoid2","avoid3"],
  "emergencySign": true,
  "emergencyReason": "if emergency, why"
}`,
      "You are a medical advisor AI. Always recommend seeing a doctor. Return ONLY valid JSON."
    );

    const data = safeJSON(raw);
    if (!data) return res.status(500).json({ error: "Failed to parse advice", raw });
    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 6. Nearby Hospitals
app.post("/api/hospitals/nearby", async (req, res) => {
  const { location, type = "Any" } = req.body;
  if (!location) return res.status(400).json({ error: "Location required" });

  try {
    const raw = await askGroq(
      `List 6 realistic hospitals near "${location}"${type !== "Any" ? ` (type: ${type})` : ""}.
Return ONLY a JSON array — no markdown — where each item has:
{ "name":"","address":"","phone":"","distance":"X km","type":"Government|Private|Clinic","emergency":true/false,"rating":"4.2","speciality":"" }`,
      "Return ONLY valid JSON array. Be realistic for the given location. No markdown."
    );

    const hospitals = safeJSON(raw) || [];
    res.json({ success: true, hospitals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 7. Medicine PDF
app.post("/api/pdf/medicine", (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: "Medicine data required" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${data.name || "medicine"}-report.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  doc.rect(0, 0, 595, 80).fill("#1a73e8");
  doc.fillColor("white").fontSize(22).font("Helvetica-Bold").text("MediScan AI", 50, 20);
  doc.fontSize(11).font("Helvetica").text("Medicine Information Report", 50, 46);
  doc.fontSize(10).text(`Generated: ${new Date().toLocaleDateString()}`, 400, 46);
  doc.fillColor("#000000").moveDown(3);

  doc.fontSize(18).font("Helvetica-Bold").fillColor("#1a73e8").text(data.name || "Unknown Medicine", 50, 100);
  doc.fontSize(11).font("Helvetica").fillColor("#555555").text(`${data.type || ""} · ${data.category || ""}`, 50, 124);
  if (data.brandNames?.length) doc.text(`Brand names: ${data.brandNames.join(", ")}`, 50, 140);

  let y = 170;

  function section(title, color = "#1a73e8") {
    if (y > 750) { doc.addPage(); y = 50; }
    doc.rect(50, y, 495, 22).fill(color);
    doc.fillColor("white").fontSize(11).font("Helvetica-Bold").text(title, 58, y + 5);
    y += 30;
    doc.fillColor("#000000").font("Helvetica").fontSize(10);
  }

  function bullet(text) {
    if (y > 750) { doc.addPage(); y = 50; }
    doc.text(`• ${text}`, 60, y, { width: 480 });
    y += doc.currentLineHeight() + 4;
  }

  if (data.mechanism) { section("Mechanism of Action"); doc.text(data.mechanism, 60, y, { width: 480 }); y += doc.currentLineHeight() + 14; }
  section("Advantages", "#0d8a4e");
  (data.advantages || []).forEach(bullet); y += 6;
  section("Disadvantages", "#c0392b");
  (data.disadvantages || []).forEach(bullet); y += 6;
  section("Side Effects", "#e67e22");
  (data.sideEffects?.common || []).forEach(bullet);
  (data.sideEffects?.serious || []).forEach(bullet);
  (data.sideEffects?.rare || []).forEach(bullet); y += 6;
  section("Contraindications", "#8e44ad");
  (data.contraindications || []).forEach(bullet); y += 6;
  section("Drug Interactions", "#2c3e50");
  (data.interactions || []).forEach(bullet); y += 6;
  if (data.storage) { section("Storage", "#16a085"); doc.text(data.storage, 60, y, { width: 480 }); y += doc.currentLineHeight() + 14; }
  if (data.overdose) { section("Overdose", "#c0392b"); doc.text(data.overdose, 60, y, { width: 480 }); y += doc.currentLineHeight() + 14; }

  doc.end();
});

// 8. Prescription PDF
app.post("/api/pdf/prescription", (req, res) => {
  const { patient, age, doctor, date, items } = req.body;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="prescription-${patient || "patient"}.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  doc.rect(0, 0, 595, 100).fill("#1a73e8");
  doc.fillColor("white").fontSize(20).font("Helvetica-Bold").text("Medical Prescription", 50, 18);
  doc.fontSize(11).font("Helvetica").text(doctor || "Doctor", 50, 44);
  doc.fontSize(10).text(`Date: ${date || new Date().toLocaleDateString()}`, 50, 60);

  doc.rect(50, 115, 495, 50).fill("#e8f0fe");
  doc.fillColor("#1a73e8").fontSize(10).font("Helvetica-Bold").text("Patient Information", 58, 122);
  doc.fillColor("#000").font("Helvetica").text(`Name: ${patient || "—"}`, 58, 136).text(`Age: ${age || "—"}`, 280, 136);

  let y = 185;
  doc.fillColor("#1a73e8").fontSize(12).font("Helvetica-Bold").text("Prescribed Medicines", 50, y);
  y += 20;

  doc.rect(50, y, 495, 22).fill("#1a73e8");
  doc.fillColor("white").fontSize(9).font("Helvetica-Bold");
  doc.text("#", 55, y + 6).text("Medicine", 75, y + 6).text("Frequency", 295, y + 6).text("Duration", 380, y + 6);
  y += 24;

  (items || []).forEach((item, idx) => {
    if (y > 720) { doc.addPage(); y = 50; }
    doc.rect(50, y, 495, 36).fill(idx % 2 === 0 ? "#f9f9f9" : "#ffffff");
    doc.fillColor("#000").fontSize(9).font("Helvetica-Bold").text(String(idx + 1), 55, y + 5);
    doc.font("Helvetica-Bold").text(item.name || "", 75, y + 5, { width: 140 });
    doc.font("Helvetica").text(item.strength || "", 75, y + 18, { width: 140 });
    doc.text(item.frequency || "", 295, y + 12, { width: 80 });
    doc.text(item.duration || "", 380, y + 12, { width: 65 });
    y += 40;
  });

  doc.end();
});

// 9. Scan PDF
app.post("/api/pdf/scan", (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: "Scan data required" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="scan-analysis.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  doc.rect(0, 0, 595, 80).fill("#0d8a4e");
  doc.fillColor("white").fontSize(20).font("Helvetica-Bold").text("Prescription Scan Report", 50, 18);
  doc.fontSize(10).font("Helvetica").text(`MediScan AI · ${new Date().toLocaleDateString()}`, 50, 46);

  let y = 100;
  const fields = [["Doctor", data.doctor], ["Clinic", data.clinic], ["Patient", data.patient], ["Date", data.date], ["Diagnosis", data.diagnosis]];
  fields.filter(f => f[1]).forEach(([label, value]) => {
    doc.rect(50, y, 145, 18).fill("#e8f0fe");
    doc.rect(195, y, 350, 18).fill("#f9f9f9");
    doc.fillColor("#1a73e8").fontSize(9).font("Helvetica-Bold").text(label, 55, y + 4);
    doc.fillColor("#000").font("Helvetica").text(value || "—", 200, y + 4, { width: 340 });
    y += 20;
  });

  y += 14;
  doc.fillColor("#1a73e8").fontSize(12).font("Helvetica-Bold").text("Extracted Medicines", 50, y);
  y += 16;

  (data.medicines || []).forEach((m, idx) => {
    doc.rect(50, y, 495, 18).fill(idx % 2 === 0 ? "#f9f9f9" : "#fff");
    doc.fillColor("#000").fontSize(9).font("Helvetica");
    doc.text(m.name || "", 55, y + 4, { width: 140 });
    doc.text(m.strength || "", 200, y + 4, { width: 75 });
    doc.text(m.frequency || "", 280, y + 4, { width: 85 });
    doc.text(m.duration || "", 370, y + 4, { width: 65 });
    y += 20;
  });

  doc.end();
});

app.listen(PORT, () => {
  console.log(`\n✅ MediScan AI server running at http://localhost:3000\n`);
});
