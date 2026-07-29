export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  joinedAt: Date;
}

export interface RoomState {
  participants: Map<string, Participant>;
  endsAt: Date | null;
  maxMeetingDuration: number | null;
}

export class RoomManager {
  private rooms: Map<string, RoomState> = new Map();

  addParticipant(roomId: string, participantData: Omit<Participant, 'joinedAt'>, endsAt?: Date | null, maxMeetingDuration?: number | null): void {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        participants: new Map(),
        endsAt: endsAt || null,
        maxMeetingDuration: maxMeetingDuration || null,
      });
    }

    const roomState = this.rooms.get(roomId)!;
    roomState.participants.set(participantData.id, {
      ...participantData,
      joinedAt: new Date(),
    });
  }

  removeParticipant(roomId: string, userId: string): void {
    const roomState = this.rooms.get(roomId);
    if (roomState) {
      roomState.participants.delete(userId);
      if (roomState.participants.size === 0) {
        this.rooms.delete(roomId);
      }
    }
  }

  updateMediaState(
    roomId: string,
    userId: string,
    state: Partial<Pick<Participant, 'audioEnabled' | 'videoEnabled' | 'screenSharing'>>
  ): void {
    const roomState = this.rooms.get(roomId);
    if (roomState) {
      const participant = roomState.participants.get(userId);
      if (participant) {
        roomState.participants.set(userId, { ...participant, ...state });
      }
    }
  }

  getParticipants(roomId: string): Participant[] {
    const roomState = this.rooms.get(roomId);
    return roomState ? Array.from(roomState.participants.values()) : [];
  }

  getRoomState(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  setRoomEndsAt(roomId: string, endsAt: Date | null): void {
    const roomState = this.rooms.get(roomId);
    if (roomState) {
      roomState.endsAt = endsAt;
    }
  }
}

export const roomManager = new RoomManager();
