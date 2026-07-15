# Frontend Board Endpoint Guide

## Overview
Previously, the frontend was using the `/tasks` endpoint with filtering to populate the board view. This approach was inefficient and required extra client-side processing to group tasks by status. We've now implemented a dedicated `/board` endpoint that returns tasks pre-grouped by their respective statuses.

## Endpoint Details

### GET /board (or /api/board)
Retrieves all task statuses and their corresponding tasks for the authenticated user's business.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer <token>`
- Query Parameters: None (no pagination, returns all tasks)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string (uuid)",
      "business_id": "string",
      "name": "string (e.g., pending, in_progress, completed)",
      "color": "string (hex color, e.g., #6b7280)",
      "is_default": "boolean",
      "sort_order": "number",
      "created_at": "string (ISO date)",
      "updated_at": "string (ISO date)",
      "tasks": [
        {
          "id": "string (uuid)",
          "title": "string",
          "description": "string | null",
          "epic": "string | null",
          "epicId": "string | null",
          "sprint": "string | null",
          "targetValue": "number",
          "accomplishedValue": "number",
          "startDate": "string (date)",
          "endDate": "string (date)",
          "dueDate": "string (date) | null",
          "status": "string",
          "isOverdue": "boolean",
          "createdAt": "string (ISO date)",
          "updatedAt": "string (ISO date)",
          "assignedTo": "string[] (user IDs)"
        }
      ]
    }
  ]
}
```

## Migration Steps for Frontend

1. **Replace Task Fetching Logic**:
   - Remove calls to `/tasks` endpoint that were used to populate the board
   - Instead, call `/board` (or `/api/board`) endpoint
   - No need for client-side grouping of tasks by status anymore

2. **Update State Management**:
   - Use the response from `/board` directly to render your board columns
   - Each column should correspond to an object in the `data` array
   - Each column's tasks are available in the `tasks` property

## Example Usage (JavaScript/React)

```javascript
// Fetch board data
const fetchBoard = async () => {
  try {
    const response = await fetch('/api/board', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const result = await response.json();
    if (result.success) {
      setBoardData(result.data);
    }
  } catch (error) {
    console.error('Failed to fetch board:', error);
  }
};

// Render board
return (
  <div className="board">
    {boardData.map(column => (
      <div key={column.id} className="board-column">
        <div className="column-header">
          <span style={{ color: column.color }}>{column.name}</span>
        </div>
        <div className="column-tasks">
          {column.tasks.map(task => (
            <div key={task.id} className="task-card">
              <h3>{task.title}</h3>
              {task.description && <p>{task.description}</p>}
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
);
```
