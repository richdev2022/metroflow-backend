import fs from 'fs';
import path from 'path';

// Test if we can read a logo file from the uploads directory
const testLogoPath = path.join(process.cwd(), 'uploads');

console.log('Current working directory:', process.cwd());
console.log('Uploads directory path:', testLogoPath);

if (fs.existsSync(testLogoPath)) {
  const files = fs.readdirSync(testLogoPath);
  console.log('Files in uploads directory:', files);
  
  if (files.length > 0) {
    const logoFile = files[0];
    const logoPath = path.join(testLogoPath, logoFile);
    console.log('Testing logo file:', logoPath);
    
    try {
      const logoBuffer = fs.readFileSync(logoPath);
      console.log('Successfully read logo file, size:', logoBuffer.length, 'bytes');
      console.log('First few bytes:', logoBuffer.slice(0, 10));
    } catch (error) {
      console.error('Error reading logo file:', error.message);
    }
  } else {
    console.log('No files found in uploads directory');
  }
} else {
  console.log('Uploads directory does not exist');
}