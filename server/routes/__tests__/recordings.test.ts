import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRecordings, createRecording, updateRecording, deleteRecording, uploadRecording } from '../recordings';
import * as db from '../../db';
import { r2Storage } from '../../lib/storage';

// Mock dependencies
vi.mock('../../db', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../lib/storage', () => ({
  r2Storage: {
    isAvailable: vi.fn().mockReturnValue(false),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    getPresignedUrl: vi.fn(),
  },
}));

vi.mock('../../services/activity', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../../lib/socket', () => ({
  getSocketServer: vi.fn(),
}));

describe('Recordings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure db.query returns a default { rows: [] }
    (db.query as any).mockResolvedValue({ rows: [] });
  });

  describe('createRecording', () => {
    it('should create a new recording successfully', async () => {
      const mockReq = {
        user: {
          businessId: 'test_biz_123',
          userId: 'test_user_123',
        },
        body: {
          meetingId: 'test_meeting_123',
        },
      };
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      const mockNext = vi.fn();

      // Mock DB query for insert
      (db.query as any).mockResolvedValueOnce({
        rows: [
          {
            id: 'test_recording_123',
            business_id: 'test_biz_123',
            meeting_id: 'test_meeting_123',
            recorded_by: 'test_user_123',
            storage_url: '',
            duration: 0,
            status: 'recording',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });

      await createRecording(mockReq as any, mockRes as any, mockNext);

      expect(db.query).toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });
  });

  describe('getRecordings', () => {
    it('should fetch recordings and generate presigned URLs', async () => {
      const mockReq = {
        user: {
          businessId: 'test_biz_123',
          userId: 'test_user_123',
        },
        query: {
          page: 1,
          limit: 10,
        },
      };
      const mockRes = {
        json: vi.fn(),
      };
      const mockNext = vi.fn();

      const mockRecordings = [
        {
          id: 'test_recording_123',
          businessId: 'test_biz_123',
          meetingId: 'test_meeting_123',
          recordedById: 'test_user_123',
          storageUrl: 'recordings/test_biz_123/test_recording_123.webm',
          duration: 60,
          status: 'completed',
          size: 1024,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recordedByName: 'Test User',
        },
      ];

      (db.query as any).mockResolvedValueOnce({ rows: [{ total: 1 }] });
      (db.query as any).mockResolvedValueOnce({ rows: mockRecordings });
      (r2Storage.isAvailable as any).mockReturnValue(true);
      (r2Storage.getPresignedUrl as any).mockResolvedValue('https://example.com/presigned-url');

      await getRecordings(mockReq as any, mockRes as any, mockNext);

      expect(r2Storage.getPresignedUrl).toHaveBeenCalledWith('recordings/test_biz_123/test_recording_123.webm', 86400);
      expect(mockRes.json).toHaveBeenCalled();
    });
  });

  describe('uploadRecording', () => {
    it('should upload recording file and update database', async () => {
      // Mock the multer middleware function to inject file
      const mockFile = {
        originalname: 'recording.webm',
        buffer: Buffer.from('test data'),
        size: 1024,
        mimetype: 'video/webm',
      };
      const mockReq = {
        user: {
          businessId: 'test_biz_123',
          userId: 'test_user_123',
        },
        params: {
          id: 'test_recording_123',
        },
        body: {
          duration: '60',
        },
        file: mockFile,
      };
      const mockRes = {
        json: vi.fn(),
      };

      const mockNext = vi.fn();

      // Mock DB check for recording existence
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'test_recording_123' }] });
      (r2Storage.isAvailable as any).mockReturnValue(true);
      (r2Storage.uploadFile as any).mockResolvedValue('recordings/test_biz_123/test_recording_123.webm');

      // Mock DB update
      const mockUpdatedRecording = {
        id: 'test_recording_123',
        businessId: 'test_biz_123',
        storage_url: 'recordings/test_biz_123/test_recording_123.webm',
        duration: 60,
        size: 1024,
        status: 'completed',
      };
      (db.query as any).mockResolvedValueOnce({ rows: [mockUpdatedRecording] });
      (r2Storage.getPresignedUrl as any).mockResolvedValue('https://example.com/presigned-url');

      // Call the second function in the uploadRecording array (the main handler)
      await uploadRecording[1](mockReq as any, mockRes as any, mockNext);

      expect(r2Storage.uploadFile).toHaveBeenCalled();
      expect(db.query).toHaveBeenCalledTimes(2); // Check + Update
      expect(mockRes.json).toHaveBeenCalled();
    });
  });

  describe('deleteRecording', () => {
    it('should delete recording from database and storage', async () => {
      const mockReq = {
        user: {
          businessId: 'test_biz_123',
          userId: 'test_user_123',
        },
        params: {
          id: 'test_recording_123',
        },
      };
      const mockRes = {
        json: vi.fn(),
      };
      const mockNext = vi.fn();

      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: 'test_recording_123', storage_url: 'recordings/test_biz_123/test_recording_123.webm' }],
      });
      (r2Storage.isAvailable as any).mockReturnValue(true);

      await deleteRecording(mockReq as any, mockRes as any, mockNext);

      expect(r2Storage.deleteFile).toHaveBeenCalledWith('recordings/test_biz_123/test_recording_123.webm');
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });
});
