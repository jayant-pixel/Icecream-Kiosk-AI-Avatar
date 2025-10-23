import { createContext, useContext } from "react";

export const RoomContext = createContext("");

export const useRoomName = () => useContext(RoomContext);
