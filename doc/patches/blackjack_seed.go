package gogame

import (
	"fmt"

	"gorm.io/gorm"
)

// Seed ordinary seated blackjack only; live/casino and hundred games differ.
func seedBlackjackIfMissing(m *gorm.DB, now int64) {
	tiers := [][4]int64{{3101, 100, 2, 500}, {3102, 500, 2, 2500}, {3103, 2000, 4, 10000}, {3104, 10000, 4, 50000}}
	for index, tier := range tiers {
		id, ante, class, carry := tier[0], tier[1], tier[2], tier[3]
		var count int64
		if err := m.Model(&RoomConfig{}).Where("room_type = ? AND game_room_config_id = ?", 31, id).Count(&count).Error; err != nil {
			continue
		}
		if count != 0 {
			continue
		}
		payload := mustJSON(map[string]any{
			"roomType": 31, "gameRoomConfigId": id, "playMode": 0,
			"ante": ante, "initialBet": 0, "seeCardNo": 0, "carryMin": carry,
			"roomClassification": class, "maxPeople": 3, "totalPeople": 0,
			"smallBlind": 0, "bigBlind": 0, "roomIndex": 0, "forceShowCard": false,
			"key": fmt.Sprintf("31/0/%d/%d/%d", ante, class, carry),
		})
		m.Create(&RoomConfig{
			GameType: 31, SubGameType: 0, RoomType: 31, GameRoomConfigId: id,
			PlayMode: 0, CarryMin: carry, Category: RoomCategoryNormal,
			Name: fmt.Sprintf("常规二十一点 底注%d", ante), Payload: payload,
			State: 1, SortIndex: int32(3100 + index), CreateTime: now, UpdateTime: now,
		})
	}
}
