package gogame

import (
	"fmt"

	"gorm.io/gorm"
)

// Ordinary thirteen-card poker; the original lobby and room types are both 27.
func seedSssIfMissing(m *gorm.DB, now int64) {
	tiers := [][5]int64{
		{2707, 1, 1, 2, 100}, {2703, 0, 200, 4, 20000},
		{2706, 1, 50, 2, 5000}, {2709, 1, 200, 4, 20000},
		{2705, 1, 10, 2, 1000}, {2701, 0, 10, 2, 1000},
		{2704, 0, 500, 4, 50000}, {2702, 0, 50, 2, 5000},
	}
	for index, tier := range tiers {
		id, mode, ante, class, carry := tier[0], tier[1], tier[2], tier[3], tier[4]
		var count int64
		if err := m.Model(&RoomConfig{}).Where("room_type = ? AND game_room_config_id = ?", 27, id).Count(&count).Error; err != nil {
			continue
		}
		if count != 0 {
			continue // Existing operator settings always take priority.
		}
		name := "十三水四鬼"
		if mode == 1 {
			name = "十三水八鬼"
		}
		payload := mustJSON(map[string]any{
			"roomType": 27, "gameRoomConfigId": id, "playMode": mode,
			"ante": ante, "initialBet": 0, "seeCardNo": 0,
			"carryMin": carry, "roomClassification": class, "maxPeople": 4,
			"smallBlind": 0, "bigBlind": 0, "roomIndex": 0, "totalPeople": 0,
			"forceShowCard": false, "straddle": false,
			"key": fmt.Sprintf("27/%d/%d/%d/%d", mode, ante, class, carry),
		})
		m.Create(&RoomConfig{
			GameType: 27, SubGameType: 0, RoomType: 27, GameRoomConfigId: id,
			PlayMode: int32(mode), CarryMin: carry, Category: RoomCategoryNormal,
			Name: fmt.Sprintf("%s 底注%d", name, ante), Payload: payload,
			State: 1, SortIndex: int32(2700 + index), CreateTime: now, UpdateTime: now,
		})
	}
}
