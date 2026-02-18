import axios from "axios";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export const uploadFile = async (file) => {
  const formData = new FormData();
  formData.append("file", file);
  return axios.post(`${API_BASE}/upload`, formData);
};

export const getRagStatus = async () => {
  return axios.get(`${API_BASE}/ragStatus`);
};

export const getToken = async ({ roomName, participantName, systemPrompt }) => {
  const participant_metadata = systemPrompt
    ? JSON.stringify({ system_prompt: systemPrompt })
    : undefined;
  const { data } = await axios.post(`${API_BASE}/getToken`, {
    room_name: roomName || "voice-rag-room",
    participant_name: participantName || "User",
    participant_metadata,
  });
  return data;
};

export const getHealth = async () => {
  return axios.get(`${API_BASE}/health`);
};
