export interface SMSProvider {
  sendSMS(to: string, message: string): Promise<any>;
}

export interface WhatsAppProvider {
  sendWhatsApp(to: string, message: string): Promise<any>;
}
