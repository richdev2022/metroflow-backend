import PDFDocument from "pdfkit";
import { ProductDocumentation } from "@shared/api";
import axios from "axios";
import fs from "fs";
import path from "path";

const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
const uploadsRoot = isLambda ? path.join("/tmp", "uploads") : path.join(process.cwd(), "uploads");

export async function generatePDF(doc: ProductDocumentation, businessName: string, ownerName: string): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const pdf = new PDFDocument({ margin: 50 });
      const buffers: Buffer[] = [];

      pdf.on("data", (buffer) => buffers.push(buffer));
      pdf.on("end", () => resolve(Buffer.concat(buffers)));
      pdf.on("error", (err) => reject(err));

      // Add Logo
      if (doc.logoUrl) {
        try {
          let logoBuffer: Buffer;
          
          console.log("PDF Generation: Attempting to load logo from:", doc.logoUrl);
          
          // Check if it is a local file URL (e.g. http://localhost:3000/uploads/...) or a relative path
          const isLocalUrl = doc.logoUrl.includes('/uploads/');
          
          if (isLocalUrl) {
             // Extract relative path from URL or use as is if already relative
             const urlParts = doc.logoUrl.split('/uploads/');
             const filename = urlParts[1];
             const filePath = path.join(uploadsRoot, filename);
             
             console.log("PDF Generation: Checking local file path:", filePath);
             
             if (fs.existsSync(filePath)) {
               logoBuffer = fs.readFileSync(filePath);
               console.log("PDF Generation: Successfully loaded logo from local file");
             } else {
               // Fallback to HTTP if file not found locally (maybe hosted elsewhere?)
               if (doc.logoUrl.startsWith("http")) {
                 console.log("PDF Generation: File not found locally, attempting HTTP fetch");
                 const response = await axios.get(doc.logoUrl, { responseType: "arraybuffer" });
                 logoBuffer = Buffer.from(response.data, "binary");
                 console.log("PDF Generation: Successfully loaded logo via HTTP");
               } else {
                  throw new Error(`Local logo file not found at ${filePath}`);
               }
             }
          } else if (doc.logoUrl.startsWith("http")) {
            console.log("PDF Generation: Loading logo via HTTP");
            const response = await axios.get(doc.logoUrl, { responseType: "arraybuffer" });
            logoBuffer = Buffer.from(response.data, "binary");
            console.log("PDF Generation: Successfully loaded logo via HTTP");
          } else {
             const relativePath = doc.logoUrl.startsWith('/') ? doc.logoUrl.slice(1) : doc.logoUrl;
             const filePath = relativePath.startsWith("uploads/")
               ? path.join(uploadsRoot, relativePath.replace(/^uploads[\\/]/, ""))
               : path.join(process.cwd(), relativePath);
             console.log("PDF Generation: Checking legacy file path:", filePath);
             if (fs.existsSync(filePath)) {
                logoBuffer = fs.readFileSync(filePath);
                console.log("PDF Generation: Successfully loaded logo from legacy path");
             } else {
                throw new Error(`Local logo file not found at ${filePath}`);
             }
          }
          
          // Add logo at the top with proper positioning
          const logoY = pdf.y + 20; // Add some margin from top
          pdf.image(logoBuffer, 50, logoY, { fit: [100, 100], align: 'center' });
          pdf.moveDown(6); // Move down significantly after logo to give space for header
          console.log("PDF Generation: Logo added to PDF at position", { x: 50, y: logoY });
        } catch (error) {
          console.error("PDF Generation: Failed to load logo", error);
        }
      }

      // Header
      pdf.font('Helvetica-Bold').fontSize(24).text(doc.title, { align: "center" });
      pdf.moveDown(0.5);
      pdf.font('Helvetica').fontSize(12).fillColor('grey').text(`Generated for: ${businessName}`, { align: "center" });
      pdf.text(`Owner: ${ownerName}`, { align: "center" });
      pdf.fillColor('black');
      pdf.moveDown(2);

      // Draw a line
      pdf.moveTo(50, pdf.y).lineTo(550, pdf.y).strokeColor('#cccccc').stroke();
      pdf.moveDown(2);

      // Content Processing
      const lines = doc.content.split("\n");
      pdf.fillColor('black');

      for (const line of lines) {
        if (line.trim().startsWith("# ")) {
          pdf.addPage(); // Start new section on new page if it's a main header, optional
          pdf.font('Helvetica-Bold').fontSize(20).text(line.replace(/^#\s+/, ""), { underline: false });
          pdf.moveDown(0.5);
        } else if (line.trim().startsWith("## ")) {
          pdf.font('Helvetica-Bold').fontSize(16).text(line.replace(/^##\s+/, ""));
          pdf.moveDown(0.5);
        } else if (line.trim().startsWith("### ")) {
          pdf.font('Helvetica-Bold').fontSize(14).text(line.replace(/^###\s+/, ""));
          pdf.moveDown(0.5);
        } else if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
          pdf.font('Helvetica').fontSize(12).text(`• ${line.replace(/^[-*]\s+/, "")}`, { indent: 20 });
        } else if (line.trim().match(/^\d+\./)) {
           pdf.font('Helvetica').fontSize(12).text(line, { indent: 20 });
        } else {
          // Regular text
          if (line.trim().length > 0) {
            pdf.font('Helvetica').fontSize(12).text(line, { align: 'justify' });
            pdf.moveDown(0.5);
          } else {
            pdf.moveDown(0.5);
          }
        }
      }

      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}
